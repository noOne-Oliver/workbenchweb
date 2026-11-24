#!/bin/sh
# 卸载 workbench：停服务、删安装目录与 /usr/local/bin/wb，默认保留工作区。
set -eu

PREFIX=@{PREFIX:-/opt/workbench}
WORKSPACE=@{WORKSPACE:-/var/lib/workbench}
PURGE=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) shift; PREFIX=@{1:?--prefix 需要目录} ;;
    --workspace) shift; WORKSPACE=@{1:?--workspace 需要目录} ;;
    --purge) PURGE=1 ;;
    --yes|-y) KEEP=1 ;;
    -h|--help) echo "用法: uninstall.sh [--prefix DIR] [--workspace DIR] [--purge] [--yes]"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  echo "! 不是 root：只会删 $PREFIX 里的文件，systemd/软链需要 sudo 手动清" >&2
fi

if [ "$KEEP" -ne 1 ]; then
  printf '将删除 %s 和 /usr/local/bin/wb，保留 %s（--purge 才删工作区）。继续？[y/N] ' "$PREFIX" "$WORKSPACE"
  read -r ans || ans=""
  case "$ans" in y|Y|yes|YES) ;; *) echo "取消了"; exit 0 ;; esac
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl stop workbench-server workbench-worker 2>/dev/null || true
  systemctl disable workbench-server workbench-worker 2>/dev/null || true
  rm -f /etc/systemd/system/workbench-server.service /etc/systemd/system/workbench-worker.service
  systemctl daemon-reload 2>/dev/null || true
fi

rm -f /usr/local/bin/wb
rm -rf "$PREFIX"
echo "✓ 已删除 $PREFIX（工作区 $WORKSPACE 保留）"

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$WORKSPACE"
  echo "✓ 已删除工作区 $WORKSPACE"
fi
