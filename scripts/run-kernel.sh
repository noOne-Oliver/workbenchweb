#!/usr/bin/env bash
# 起本地内核（server + 看护着的 worker）。用 launchd 拉起来才活得过终端/会话。
# 用法：launchctl submit -l local.workbench.kernel -- /bin/bash scripts/run-kernel.sh
#       launchctl remove local.workbench.kernel   # 停掉
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"
export WB_ENGINE="${WB_ENGINE:-mock}"
export WB_ROOT="${WB_ROOT:-$ROOT}"
: "${WB_PORT:=7317}"; export WB_PORT
mkdir -p data
exec node src/cli.mjs up >> data/kernel.log 2>&1