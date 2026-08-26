#!/bin/sh
# AperturePrism in-container qq-bot lifecycle control.
# Runs inside the api container (which has docker CLI + compose + docker.sock).
# Usage: botctl.sh <status|start|stop>
# Outputs a short state string for `status` (running/exited/absent), or the
# compose command output for start/stop. Exit code is 0 on success.
set -u

ACTION="${1:-status}"
PROJECT="${COMPOSE_PROJECT_NAME:-apertureprism-ai-review}"
BASE_DIR="/app/docker"
ENV_FILE="$BASE_DIR/.env.production"

# Rebuild the compose env file from the container environment so the script
# (and any nested `env_file:` in compose) has every production variable —
# mirrors update.sh so QQ_/DATABASE_/REDIS_ etc. are always present.
env | grep -E '^(DATABASE_URL|REDIS_URL|POSTGRES_|WEBUI_API_TOKEN|GITHUB_|MODEL_PROVIDER_BASE_URLS|CREDENTIAL_MASTER_KEY|EMBEDDING_|QQ_|INDEX_INTERVAL_MS|API_PORT|WEB_PORT|HOST|PORT|LOG_LEVEL|NODE_ENV)=' > "$ENV_FILE" || true

COMPOSE_FILES="-f $BASE_DIR/docker-compose.prod.yml"
if [ "${AP_VERIFY:-0}" = "1" ] && [ -f "$BASE_DIR/compose.verify.yml" ]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $BASE_DIR/compose.verify.yml"
fi
compose() { docker compose --project-name "$PROJECT" $COMPOSE_FILES --env-file "$ENV_FILE" "$@"; }

case "$ACTION" in
  status)
    OUT="$(compose ps --format json qq-bot 2>/dev/null)"
    if [ -z "$OUT" ]; then
      echo "absent"
    else
      STATE="$(printf '%s' "$OUT" | sed -n 's/.*"State"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
      echo "${STATE:-unknown}"
    fi
    ;;
  start)
    compose --profile qq up -d qq-bot
    ;;
  stop)
    compose stop qq-bot
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
