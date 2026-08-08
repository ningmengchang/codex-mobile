#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 sudo 运行：sudo %s\n' "$0" >&2
  exit 1
fi

systemctl disable --now codex-mobile.service 2>/dev/null || true
rm -f /etc/systemd/system/codex-mobile.service
systemctl daemon-reload
printf 'Codex Mobile 服务已停止。可手动删除 /opt/codex-mobile；服务数据和源码均已保留。\n'
