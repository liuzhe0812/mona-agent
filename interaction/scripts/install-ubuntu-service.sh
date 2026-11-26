#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -z "${MONA_INTERACTION_MANAGED_PYTHON:-}" ]]; then
    echo "安装用户服务需要指定已准备的受管 Python 和完整本机配置；开发预览请使用 start-ubuntu.sh。" >&2
    exit 1
fi

systemctl --user show-environment >/dev/null
/bin/bash "$project_dir/scripts/ubuntu-managed-launcher.sh" install \
    "${MONA_INTERACTION_RUNTIME_ROOT:-$HOME/.mona/runtimes}" \
    "$MONA_INTERACTION_MANAGED_PYTHON" "$@"
systemctl --user daemon-reload
systemctl --user enable --now mona-interaction.service
echo "Service enabled and start requested. Check: systemctl --user status mona-interaction.service"
