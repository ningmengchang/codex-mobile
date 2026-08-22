#!/usr/bin/env bash
set -euo pipefail

readonly CODEX_LINK="/home/ningmengchang/.local/bin/codex"
readonly DEPLOY_DIR="/opt/codex-mobile"
readonly SERVICE_NAME="codex-mobile.service"
readonly MOBILE_URL="${CODEX_MOBILE_URL:-http://127.0.0.1:3765/}"
readonly OWNER="ningmengchang"
readonly GROUP="ningmengchang"

if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 sudo 运行：sudo %s\n' "$0" >&2
  exit 1
fi

test -x "$CODEX_LINK" || {
  printf '未找到 Codex：%s\n' "$CODEX_LINK" >&2
  exit 1
}

CODEX_ENTRYPOINT="$(readlink -f "$CODEX_LINK")"
CODEX_RELEASE_DIR="$(dirname "$(dirname "$CODEX_ENTRYPOINT")")"

for required in \
  bin/codex \
  bin/codex-code-mode-host \
  codex-package.json \
  codex-path \
  codex-resources; do
  test -e "$CODEX_RELEASE_DIR/$required" || {
    printf 'Codex 发行包不完整，缺少：%s\n' "$CODEX_RELEASE_DIR/$required" >&2
    exit 1
  }
done

service_was_active=false
if systemctl is-active --quiet "$SERVICE_NAME"; then
  service_was_active=true
  systemctl stop "$SERVICE_NAME"
fi

restore_service() {
  if [[ "$service_was_active" == true ]]; then
    systemctl start "$SERVICE_NAME" || true
  fi
}
trap restore_service EXIT

install -d -o "$OWNER" -g "$GROUP" -m 0755 \
  "$DEPLOY_DIR/bin" "$DEPLOY_DIR/codex-path" "$DEPLOY_DIR/codex-resources"
install -o "$OWNER" -g "$GROUP" -m 0755 \
  "$CODEX_RELEASE_DIR/bin/codex" "$DEPLOY_DIR/bin/codex"
install -o "$OWNER" -g "$GROUP" -m 0755 \
  "$CODEX_RELEASE_DIR/bin/codex-code-mode-host" "$DEPLOY_DIR/bin/codex-code-mode-host"
cp -a "$CODEX_RELEASE_DIR/codex-path/." "$DEPLOY_DIR/codex-path/"
cp -a "$CODEX_RELEASE_DIR/codex-resources/." "$DEPLOY_DIR/codex-resources/"
install -o "$OWNER" -g "$GROUP" -m 0644 \
  "$CODEX_RELEASE_DIR/codex-package.json" "$DEPLOY_DIR/codex-package.json"
chown -R "$OWNER:$GROUP" "$DEPLOY_DIR/codex-path" "$DEPLOY_DIR/codex-resources"

cmp -s "$CODEX_RELEASE_DIR/bin/codex" "$DEPLOY_DIR/bin/codex"
cmp -s "$CODEX_RELEASE_DIR/bin/codex-code-mode-host" "$DEPLOY_DIR/bin/codex-code-mode-host"

if [[ "$service_was_active" == true ]]; then
  systemctl start "$SERVICE_NAME"
  service_was_active=false
  systemctl is-active --quiet "$SERVICE_NAME"

  page_ready=false
  for _ in {1..20}; do
    if curl -fsS --max-time 2 "$MOBILE_URL" >/dev/null 2>&1; then
      page_ready=true
      break
    fi
    sleep 0.25
  done
  if [[ "$page_ready" != true ]]; then
    printf 'Codex Mobile 服务已启动，但页面未就绪：%s\n' "$MOBILE_URL" >&2
    exit 1
  fi
fi
trap - EXIT

source_version="$(runuser -u "$OWNER" -- "$CODEX_ENTRYPOINT" --version)"
deployed_version="$(runuser -u "$OWNER" -- "$DEPLOY_DIR/bin/codex" --version)"
if [[ "$source_version" != "$deployed_version" ]]; then
  printf '版本校验失败：当前=%s，部署=%s\n' "$source_version" "$deployed_version" >&2
  exit 1
fi
runuser -u "$OWNER" -- "$DEPLOY_DIR/bin/codex-code-mode-host" --help >/dev/null

printf 'Codex Mobile 运行时已同步：%s\n' "$deployed_version"
if systemctl is-active --quiet "$SERVICE_NAME"; then
  printf '服务状态：active\n'
else
  printf '服务保持升级前的非运行状态。\n'
fi
