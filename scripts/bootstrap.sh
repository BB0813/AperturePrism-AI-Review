#!/usr/bin/env bash
# AperturePrism 一键安装 - GitHub 直跑入口（单文件，可 curl | bash）
#
# 用法：
#   # 直跑（拉取最新 main 源码到本地目录再安装）：
#   curl -fsSL https://raw.githubusercontent.com/BB0813/AperturePrism-AI-Review/main/scripts/bootstrap.sh | bash
#   # 传参（例如跳过容器/跳过构建）：
#   curl -fsSL .../scripts/bootstrap.sh | bash -s -- --skip-docker
#   # 本地已检出仓库时直接调用本文件，等价于执行 ./scripts/install.sh：
#   ./scripts/bootstrap.sh --help
#
# 环境变量覆盖：
#   APERTUREPRISM_REPO_URL  仓库地址（默认 https://github.com/BB0813/AperturePrism-AI-Review.git）
#   APERTUREPRISM_REF       分支或标签（默认 main）
#   APERTUREPRISM_SRC_DIR   本地安装源码目录（默认 $HOME/.apertureprism/AperturePrism-AI-Review）
set -euo pipefail

REPO_URL="${APERTUREPRISM_REPO_URL:-https://github.com/BB0813/AperturePrism-AI-Review.git}"
REF="${APERTUREPRISM_REF:-main}"
SRC_DIR="${APERTUREPRISM_SRC_DIR:-$HOME/.apertureprism/AperturePrism-AI-Review}"

# 已在本地检出时直接复用（等价于本地跑 install.sh），避免重复下载。
is_local_checkout() {
  local source_file="${BASH_SOURCE[0]:-}"
  [[ -n "$source_file" && -f "$source_file" ]] || return 1
  local root
  root="$(cd "$(dirname "$source_file")/.." 2>/dev/null && pwd)" || return 1
  [[ -f "$root/package.json" && -f "$root/scripts/install.sh" ]]
}

# 从 GitHub 拉取源码到稳定目录；已存在合法检出则复用。
acquire() {
  if [[ -f "$SRC_DIR/package.json" && -f "$SRC_DIR/scripts/install.sh" ]]; then
    echo "[OK] 复用本地源码: $SRC_DIR"
    return 0
  fi
  echo "[INFO] 下载 AperturePrism 源码 → $SRC_DIR (ref=$REF)"
  local parent
  parent="$(dirname "$SRC_DIR")"
  mkdir -p "$parent"
  rm -rf "$SRC_DIR.tmp"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$SRC_DIR.tmp" \
      || { rm -rf "$SRC_DIR.tmp"; return 1; }
  else
    # 无 git 时回退到 codeload tarball（REF 需为分支名）。
    local archive
    archive="https://codeload.github.com/BB0813/AperturePrism-AI-Review/tar.gz/refs/heads/$REF"
    mkdir -p "$SRC_DIR.tmp"
    curl -fsSL "$archive" | tar -xz --strip-components=1 -C "$SRC_DIR.tmp" \
      || { rm -rf "$SRC_DIR.tmp"; return 1; }
  fi
  if [[ ! -f "$SRC_DIR.tmp/scripts/install.sh" ]]; then
    echo "[FAIL] 拉取的源码缺少 scripts/install.sh" >&2
    rm -rf "$SRC_DIR.tmp"
    return 1
  fi
  rm -rf "$SRC_DIR"
  mv "$SRC_DIR.tmp" "$SRC_DIR"
  return 0
}

main() {
  if is_local_checkout; then
    local root
    root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$root"
    exec ./scripts/install.sh "$@"
  fi
  acquire || { echo "[FAIL] 源码下载失败，请检查网络与仓库地址" >&2; exit 1; }
  cd "$SRC_DIR"
  exec ./scripts/install.sh "$@"
}

main "$@"
