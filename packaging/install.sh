#!/bin/sh
# workbench 离线单包安装脚本。全程不联网、不 npm install。
#
#   sudo ./install.sh                  # /opt/workbench + /var/lib/workbench + systemd
#   ./install.sh --prefix "$HOME/wb"   # 任意前缀，不装 systemd，不碰 /etc
#
# 选项：
#   --prefix DIR      安装目录（默认 /opt/workbench）
#   --workspace DIR   工作区（默认 root: /var/lib/workbench；否则 <prefix>/workspace）
#   --env-file PATH   配置文件（默认 root: /etc/workbench/workbench.env；否则 <prefix>/workbench.env）
#   --user NAME       systemd 以谁的身份跑（默认 sudo 的调用者，否则 root）
#   --no-systemd      即使 root 也不装 unit
#   --force           覆盖已安装的同前缀
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PREFIX=""
WORKSPACE=""
ENV_FILE=""
NO_SYSTEMD=0
FORCE=0
RUN_USER=""
IS_ROOT=0
[ "$(id -u)" -eq 0 ] && IS_ROOT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) shift; PREFIX=${1:?--prefix 需要目录} ;;
    --workspace) shift; WORKSPACE=${1:?--workspace 需要目录} ;;
    --env-file) shift; ENV_FILE=${1:?--env-file 需要路径} ;;
    --user) shift; RUN_USER=${1:?--user 需要用户名} ;;
    --no-systemd) NO_SYSTEMD=1 ;;
    --force|-f) FORCE=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) printf '未知参数: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$PREFIX" ]; then
  if [ "$IS_ROOT" -eq 1 ]; then PREFIX=/opt/workbench; else PREFIX=${HOME:-$PWD}/workbench; fi
fi
if [ -z "$WORKSPACE" ]; then
  if [ "$IS_ROOT" -eq 1 ] && [ "$PREFIX" = "/opt/workbench" ]; then WORKSPACE=/var/lib/workbench; else WORKSPACE=$PREFIX/workspace; fi
fi
if [ -z "$ENV_FILE" ]; then
  if [ "$IS_ROOT" -eq 1 ] && [ "$PREFIX" = "/opt/workbench" ]; then ENV_FILE=/etc/workbench/workbench.env; else ENV_FILE=$PREFIX/workbench.env; fi
fi
if [ -z "$RUN_USER" ] && [ "$IS_ROOT" -eq 1 ] && [ -n "${SUDO_USER:-}" ]; then RUN_USER=$SUDO_USER; fi

SYSTEMD=0
if [ "$IS_ROOT" -eq 1 ] && [ "$NO_SYSTEMD" -eq 0 ] && [ "$PREFIX" = "/opt/workbench" ]; then
  if command -v systemctl >/dev/null 2>&1; then SYSTEMD=1; else
    printf '! 没有 systemctl，跳过 systemd（用 wb up 启动）\n' >&2
  fi
fi

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
step() { printf '\n· %s\n' "$*"; }

# ---- 0. 这是不是一个完整的包 ------------------------------------------------
for f in bin/node bin/wb kernel/src/server/index.mjs kernel/src/cli.mjs engine/opencode SHA256SUMS; do
  [ -e "$SELF_DIR/$f" ] || die "包不完整：缺 $f（请在解压出来的 workbench-* 目录里运行 ./install.sh）"
done
[ -x "$SELF_DIR/bin/node" ] || chmod 755 "$SELF_DIR/bin/node" 2>/dev/null || true

if [ -e "$PREFIX/bin/node" ] && [ "$FORCE" -ne 1 ]; then
  die "$PREFIX 里已经有安装了。要覆盖：./install.sh --force；要清掉：uninstall.sh --prefix $PREFIX"
fi

printf 'workbench 离线包安装\n  包目录   %s\n  安装到   %s\n  工作区   %s\n  配置     %s\n  systemd  %s\n  node     %s\n' \
  "$SELF_DIR" "$PREFIX" "$WORKSPACE" "$ENV_FILE" \
  "$([ "$SYSTEMD" -eq 1 ] && echo 是 || echo 否)" "$("$SELF_DIR/bin/node" -v)"

# ---- 1. 校验 SHA256SUMS（用包里的 node，机器上没有 sha256sum 也行）---------
step "校验包完整性（SHA256SUMS）"
"$SELF_DIR/bin/node" -e '
  const { createHash } = require("crypto");
  const { readFileSync } = require("fs");
  const { resolve } = require("path");
  const root = process.argv[1];
  const lines = readFileSync(resolve(root, "SHA256SUMS"), "utf8").trim().split("\n").filter(Boolean);
  let bad = 0;
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!m) { console.log("无法解析:", line); bad++; continue; }
    try {
      const got = createHash("sha256").update(readFileSync(resolve(root, m[2]))).digest("hex");
      if (got !== m[1]) { console.log("不匹配:", m[2]); bad++; }
    } catch { console.log("读不到:", m[2]); bad++; }
  }
  if (bad) { console.error(bad + " 个文件校验失败，包可能损坏，先重传"); process.exit(1); }
  console.log("  " + lines.length + " 个文件全部匹配");
' "$SELF_DIR" || die "包校验失败，拒绝安装"

# ---- 2. 铺文件 --------------------------------------------------------------
step "复制到 $PREFIX"
mkdir -p "$PREFIX/bin" "$PREFIX/licenses"
if [ "$FORCE" -eq 1 ]; then
  rm -rf "$PREFIX/kernel" "$PREFIX/engine"
fi
cp -p "$SELF_DIR/bin/node" "$PREFIX/bin/node"
cp -p "$SELF_DIR/bin/wb" "$PREFIX/bin/wb"
chmod 755 "$PREFIX/bin/node" "$PREFIX/bin/wb"
rm -rf "$PREFIX/kernel" "$PREFIX/engine"
cp -Rp "$SELF_DIR/kernel" "$PREFIX/kernel"
cp -Rp "$SELF_DIR/engine" "$PREFIX/engine"
chmod 755 "$PREFIX/engine/opencode"
cp -Rp "$SELF_DIR/licenses/." "$PREFIX/licenses/"
for f in README-OFFLINE.md config.example.env uninstall.sh VERSIONS SHA256SUMS; do
  [ -e "$SELF_DIR/$f" ] && cp -p "$SELF_DIR/$f" "$PREFIX/$f"
done
chmod 755 "$PREFIX/uninstall.sh" 2>/dev/null || true

# ---- 3. 工作区 --------------------------------------------------------------
step "建工作区 $WORKSPACE"
mkdir -p "$WORKSPACE/data" "$WORKSPACE/worktrees" "$WORKSPACE/.oc"
chmod 750 "$WORKSPACE" 2>/dev/null || true
if [ -n "$RUN_USER" ] && [ "$IS_ROOT" -eq 1 ]; then
  chown -R "$RUN_USER" "$WORKSPACE" 2>/dev/null || printf '! chown %s 失败（忽略）\n' "$RUN_USER" >&2
fi
if command -v git >/dev/null 2>&1; then
  WB_HOME=$PREFIX WB_CODE=$PREFIX/kernel WB_ROOT=$WORKSPACE WB_WORKSPACE=$WORKSPACE \
    "$PREFIX/bin/node" "$PREFIX/kernel/src/cli.mjs" workspace --dir "$WORKSPACE" >/dev/null 2>&1 \
    || printf '! 起始仓库没建成功（不影响服务启动，提交任务时会再试）\n' >&2
else
  printf '! 没装 git：起始仓库和 worktree 都要 git，请先安装 git（包不代装）\n' >&2
fi

# ---- 4. 配置文件（600，按当前 WB_* 环境生成）--------------------------------
step "写配置 $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
want() {
  name=$1
  eval "val=\${$name:-}"
  if [ -n "$val" ]; then printf '%s=%s\n' "$name" "$val"; fi
}
{
  printf '# workbench 配置 —— 由 install.sh 生成，可以手改。\n'
  printf '# 完整说明见 config.example.env；文件权限必须是 600（里面有 LLM key）。\n'
  printf 'WB_HOME=%s\n' "$PREFIX"
  printf 'WB_CODE=%s\n' "$PREFIX/kernel"
  printf 'WB_WORKSPACE=%s\n' "$WORKSPACE"
  printf 'WB_ROOT=%s\n' "$WORKSPACE"
  printf 'WB_DB=%s\n' "$WORKSPACE/data/ledger.db"
  printf 'WB_OC_HOME=%s\n' "$WORKSPACE/.oc"
  printf 'WB_HOST=%s\n' "${WB_HOST:-0.0.0.0}"
  printf 'WB_PORT=%s\n' "${WB_PORT:-7317}"
  printf 'WB_ENGINE=%s\n' "${WB_ENGINE:-opencode}"
  for k in WB_ENGINE_BIN WB_LLM_BASE_URL WB_LLM_MODEL WB_LLM_API_KEY WB_TOKEN WB_BUDGET WB_NO_NPM WB_NO_AUTH WB_LOG_LINES; do
    want "$k"
  done
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"
if [ -n "$RUN_USER" ] && [ "$IS_ROOT" -eq 1 ]; then
  chown "$RUN_USER" "$ENV_FILE" 2>/dev/null || true
fi
printf '  已写 %s（600）—— 记得填 WB_LLM_BASE_URL / WB_LLM_MODEL / WB_LLM_API_KEY\n' "$ENV_FILE"

# ---- 5. systemd -------------------------------------------------------------
if [ "$SYSTEMD" -eq 1 ]; then
  step "装 systemd unit（workbench-server / workbench-worker）"
  mkdir -p /etc/systemd/system
  unit_common() {
    printf '[Unit]\nDescription=workbench %s（离线单包）\nAfter=network.target\n\n[Service]\nType=simple\nEnvironmentFile=%s\nWorkingDirectory=%s\n' "$1" "$ENV_FILE" "$WORKSPACE"
    if [ -n "$RUN_USER" ]; then printf 'User=%s\n' "$RUN_USER"; fi
    printf 'Restart=on-failure\nRestartSec=3\n'
  }
  {
    unit_common server
    printf 'ExecStart=%s/bin/node %s/kernel/src/server/index.mjs\n\n[Install]\nWantedBy=multi-user.target\n' "$PREFIX" "$PREFIX"
  } >/etc/systemd/system/workbench-server.service
  {
    unit_common worker
    printf 'ExecStart=%s/bin/node %s/kernel/src/cli.mjs run\n\n[Install]\nWantedBy=multi-user.target\n' "$PREFIX" "$PREFIX"
  } >/etc/systemd/system/workbench-worker.service
  systemctl daemon-reload 2>/dev/null || true
  printf '  unit 已装（还没启动）\n'
fi

# ---- 6. PATH ---------------------------------------------------------------
step "装 wb 到 PATH"
if [ "$IS_ROOT" -eq 1 ]; then
  mkdir -p /usr/local/bin
  ln -sf "$PREFIX/bin/wb" /usr/local/bin/wb
  printf '  软链 %s\n' "/usr/local/bin/wb -> $PREFIX/bin/wb"
else
  printf '  没 root，不加软链。请把下面一行加进 shell 配置：\n    export PATH="%s/bin:$PATH"\n' "$PREFIX"
fi

# ---- 7. 收尾 ---------------------------------------------------------------
WB_ENV_FILE=$ENV_FILE "$PREFIX/bin/wb" doctor || {
  printf "\n! doctor 有硬失败项（上面 [FAIL]），安装文件已就位，配置修好后重跑: WB_ENV_FILE=%s %s/bin/wb doctor\n" "$ENV_FILE" "$PREFIX" >&2
}

printf '\n✓ 安装完成\n'
if [ "$SYSTEMD" -eq 1 ]; then
  printf '  启动    sudo systemctl enable --now workbench-server workbench-worker\n'
  printf '  日志    journalctl -u workbench-server -f\n'
else
  printf '  启动    WB_ENV_FILE=%s %s/bin/wb up\n' "$ENV_FILE" "$PREFIX"
fi
printf '  配置    %s（600）\n' "$ENV_FILE"
printf '  体检    wb doctor\n'
printf '  地址    http://<主机>:%s/\n' "${WB_PORT:-7317}"
