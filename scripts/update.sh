#!/bin/sh
# AperturePrism in-container online update.
# Runs inside the api container (which has docker CLI + compose + docker.sock).
# Steps: pull -> migrate -> up --force-recreate -> health poll -> rollback on fail.
# Outputs one JSON line per step: {"level":"info|warn|error","message":"..."}
set -u

TARGET="latest"
PROJECT="apertureprism-ai-review"
API_URL="http://127.0.0.1:30001"
BACKUP=0
DRY_RUN=0
BASE_DIR="/app/docker"
COMPOSE_FILE="$BASE_DIR/docker-compose.prod.yml"
ENV_FILE="$BASE_DIR/.env.production"

log() { echo "{\"level\":\"$1\",\"message\":\"$2\"}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --api) API_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --backup) BACKUP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) shift ;;
  esac
done

case "$TARGET" in
  v[0-9]*.[0-9]*.[0-9]*|latest|stable) ;;
  *) log error "invalid target: $TARGET"; exit 1 ;;
esac

OLD_TAG="${IMAGE_TAG:-latest}"
log info "update target=$TARGET current=$OLD_TAG project=$PROJECT"

# Rebuild the compose env file from the container environment so the script
# (and any nested `env_file:` in compose) has every production variable.
env | grep -E '^(DATABASE_URL|REDIS_URL|POSTGRES_|WEBUI_API_TOKEN|GITHUB_|MODEL_PROVIDER_BASE_URLS|CREDENTIAL_MASTER_KEY|EMBEDDING_|QQ_|INDEX_INTERVAL_MS|API_PORT|WEB_PORT|HOST|PORT|LOG_LEVEL|NODE_ENV)=' > "$ENV_FILE" || true
echo "IMAGE_TAG=$TARGET" >> "$ENV_FILE"

# Compose runs from the api container's cwd (/app), so reference the compose
# files by absolute path under BASE_DIR to avoid "no such file or directory".
COMPOSE_FILES="-f $BASE_DIR/docker-compose.prod.yml"
if [ "${AP_VERIFY:-0}" = "1" ] && [ -f "$BASE_DIR/compose.verify.yml" ]; then
  COMPOSE_FILES="-f $BASE_DIR/docker-compose.prod.yml -f $BASE_DIR/compose.verify.yml"
fi

# Preflight: fail loudly with an actionable hint instead of a cryptic
# "open ...: no such file or directory" from docker compose. Images before
# v1.0.7 baked the update.sh with relative paths and cannot self-update; they
# must be upgraded once manually (see README「升级」).
if [ ! -f "$BASE_DIR/docker-compose.prod.yml" ]; then
  log error "缺少 compose 文件 $BASE_DIR/docker-compose.prod.yml"
  log error "当前镜像版本过旧（< v1.0.7）无法在线自更新，请手动升级一次："
  log error "  编辑部署目录 docker/.env.production 中 IMAGE_TAG=vX.Y.Z 后执行："
  log error "  docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.production pull"
  log error "  docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.production up -d"
  exit 1
fi
compose() { docker compose --project-name "$PROJECT" $COMPOSE_FILES --env-file "$ENV_FILE" "$@"; }

if [ "$DRY_RUN" = "1" ]; then
  log info "dry-run: would pull $TARGET, run migrate, then up -d --force-recreate"
  exit 0
fi

if [ "$BACKUP" = "1" ] && [ -f /app/scripts/backup.mjs ]; then
  log info "backing up configuration…"
  if node /app/scripts/backup.mjs >/dev/null 2>&1; then
    log info "backup ok"
  else
    log warn "backup failed (continuing)"
  fi
fi

log info "pulling $TARGET…"
if ! compose pull 2>&1; then
  log error "pull failed"
  exit 1
fi
log info "pull ok"

log info "applying migrations…"
if ! compose run --rm migrate 2>&1; then
  log error "migrate failed"
  exit 1
fi
log info "migrate ok"

log info "recreating containers…"
if ! compose up -d --force-recreate 2>&1; then
  log error "up failed"
  exit 1
fi
log info "up ok"

attempt=0
while [ "$attempt" -lt 12 ]; do
  attempt=$((attempt + 1))
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/health/ready" 2>/dev/null)
  if [ "$code" = "200" ]; then
    log info "health ok (attempt $attempt)"
    exit 0
  fi
  log info "health pending ($code, attempt $attempt/12)"
  sleep 5
done

log error "health check failed; rolling back to $OLD_TAG"
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$OLD_TAG/" "$ENV_FILE"
if compose up -d --force-recreate 2>&1; then
  log info "rolled back to $OLD_TAG"
else
  log error "rollback failed; manual intervention required"
fi
exit 1
