#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_DIR="/home/ningmengchang/ideaProjects/codex-mobile"
readonly DEPLOY_DIR="/opt/codex-mobile"
readonly SERVICE_FILE="/etc/systemd/system/codex-mobile.service"

if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 sudo 运行：sudo %s\n' "$0" >&2
  exit 1
fi

test -f /home/ningmengchang/.codex/config.toml || {
  printf '未找到 /home/ningmengchang/.codex/config.toml，请先配置 ningmengchang 的 Codex。\n' >&2
  exit 1
}
test -x /home/ningmengchang/.local/bin/codex || {
  printf '未找到 Codex：/home/ningmengchang/.local/bin/codex\n' >&2
  exit 1
}

install -d -o ningmengchang -g ningmengchang -m 0755 "$DEPLOY_DIR" "$DEPLOY_DIR/bin" "$DEPLOY_DIR/server" "$DEPLOY_DIR/public" "$DEPLOY_DIR/scripts"
install -o ningmengchang -g ningmengchang -m 0755 "$(readlink -f /home/ningmengchang/.local/bin/codex)" "$DEPLOY_DIR/bin/codex"
for source in "$PROJECT_DIR"/server/*.mjs; do
  install -o ningmengchang -g ningmengchang -m 0644 "$source" "$DEPLOY_DIR/server/$(basename "$source")"
done
install -o ningmengchang -g ningmengchang -m 0644 "$PROJECT_DIR/server/xlsx-preview.py" "$DEPLOY_DIR/server/xlsx-preview.py"
for source in "$PROJECT_DIR"/public/*; do
  install -o ningmengchang -g ningmengchang -m 0644 "$source" "$DEPLOY_DIR/public/$(basename "$source")"
done
install -o ningmengchang -g ningmengchang -m 0644 "$PROJECT_DIR/package.json" "$DEPLOY_DIR/package.json"
install -o ningmengchang -g ningmengchang -m 0755 "$PROJECT_DIR/scripts/pair.mjs" "$DEPLOY_DIR/scripts/pair.mjs"
install -o ningmengchang -g ningmengchang -m 0755 "$PROJECT_DIR/scripts/check-protocol.mjs" "$DEPLOY_DIR/scripts/check-protocol.mjs"
install -m 0644 "$PROJECT_DIR/systemd/codex-mobile.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable --now codex-mobile.service

printf '\n服务已经启动。当前状态：\n'
systemctl --no-pager --full status codex-mobile.service || true
printf '\n生成首次配对码：\n'
/usr/bin/node "$DEPLOY_DIR/scripts/pair.mjs"
