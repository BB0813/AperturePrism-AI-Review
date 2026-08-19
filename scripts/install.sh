#!/usr/bin/env bash
# AperturePrism 一键安装（Linux / macOS）
#
# 用法:
#   ./scripts/install.sh              # 完整安装
#   ./scripts/install.sh --skip-docker
#   ./scripts/install.sh --help
#
# Windows 用户直接执行: node scripts/install.mjs
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/install.mjs "$@"
