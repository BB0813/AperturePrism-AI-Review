#!/usr/bin/env bash
# AperturePrism NAS 部署脚本：pull + up 一条命令，--tag 指定版本，出错可回滚。
#
# 用法（在 NAS 的 /root/ap-verify 下）：
#   bash deploy.sh                    # 用 .env.production 里当前的 IMAGE_TAG
#   bash deploy.sh --tag v1.0.64      # 切到指定版本
#   bash deploy.sh --rollback         # 回滚到上一个成功版本（update marker 记录）
#
# 约定：与既有部署一致的三个 compose 文件叠加 + 根 .env.production 提供 IMAGE_TAG。

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env.production"
MARKER="$DIR/.last-good-tag"
COMPOSE_FILES=(-f docker/docker-compose.prod.yml -f docker/images-mirror.yml -f docker/compose.verify.yml)
SERVICES=(web api scheduler scan-worker index-worker analysis-worker)

compose() {
  # 必须先 cd 到根目录：compose 相对路径（docker/...）与 --env-file 都以它为基准。
  (cd "$DIR" && docker compose "${COMPOSE_FILES[@]}" --env-file "$(basename "$ENV_FILE")" "$@")
}

current_tag() {
  grep -E '^IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]'
}

set_tag() {
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$1/" "$ENV_FILE"
}

TARGET=""
ROLLBACK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TARGET="$2"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

if [[ $ROLLBACK -eq 1 ]]; then
  if [[ ! -f $MARKER ]]; then
    echo "没有可回滚的记录（$MARKER 不存在）"; exit 1
  fi
  TARGET=$(cat "$MARKER")
  echo "== 回滚到上次成功版本: $TARGET =="
elif [[ -n $TARGET ]]; then
  set_tag "$TARGET"
else
  TARGET=$(current_tag)
  echo "== 使用当前 IMAGE_TAG: $TARGET =="
fi

echo "== pull =="
compose pull "${SERVICES[@]}" || { echo "pull 失败，保持原版本运行"; exit 1; }

echo "== up =="
compose up -d "${SERVICES[@]}" || { echo "up 失败"; exit 1; }

echo "== 健康检查（最多等 60s）=="
ok=0
for _ in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3300/health/live || true)
  if [[ $code == "200" ]]; then ok=1; break; fi
  sleep 5
done

if [[ $ok -eq 1 ]]; then
  echo "$TARGET" > "$MARKER"
  echo "== 部署成功: $TARGET（已记入 $MARKER，可用 --rollback 回滚）=="
else
  echo "== 健康检查未通过 =="
  if [[ $ROLLBACK -eq 0 && -f $MARKER ]]; then
    PREV=$(cat "$MARKER")
    if [[ "$PREV" != "$TARGET" ]]; then
      echo "== 自动回滚到 $PREV =="
      set_tag "$PREV"
      compose pull "${SERVICES[@]}" >/dev/null 2>&1 || true
      compose up -d "${SERVICES[@]}"
      echo "已回滚。目标版本 $TARGET 的问题请查镜像构建日志。"
    fi
  fi
  exit 1
fi
