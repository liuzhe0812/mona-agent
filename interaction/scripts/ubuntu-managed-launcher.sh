#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if (( $# < 3 )); then
    echo "受管运行环境参数不完整。" >&2
    exit 1
fi
action="$1"
root_input="$2"
python_input="$3"
shift 3
if [[ "$action" != run && "$action" != install ]] || [[ "$root_input" != /* || "$python_input" != /* ]]; then
    echo "受管运行环境必须使用明确的绝对路径。" >&2
    exit 1
fi
root="$(realpath -e -- "$root_input")"
root_lexical="$(realpath -s -e -- "$root_input")"
python="$(realpath -s -e -- "$python_input")"
parent="$(realpath -e -- "$(dirname -- "$python")")"
target="$(realpath -e -- "$python")"
if [[ "$root" == / || ! -d "$root" || "$(basename -- "$python")" != python || ! -f "$python" || ! -x "$python" ]]; then
    echo "受管 Python 路径无效。" >&2
    exit 1
fi
case "$python" in "$root/"*|"$root_lexical/"*) ;; *) echo "受管 Python 超出运行时范围。" >&2; exit 1 ;; esac
case "$parent/" in "$root/"*) ;; *) echo "受管 Python 超出运行时范围。" >&2; exit 1 ;; esac
case "$target" in "$root/"*) ;; *) echo "受管 Python 目标超出运行时范围。" >&2; exit 1 ;; esac
relative="${parent#"$root"/}"
if [[ ! "$relative" =~ ^python/[a-z0-9][a-z0-9._-]*-envs/[0-9a-f]{32}/bin$ ]] || [[ ! -f "$parent/../environment.json" ]]; then
    echo "Python 不属于已准备的受管环境。" >&2
    exit 1
fi
python="$parent/python"
helper="$(realpath -e -- "$project_dir/scripts/ubuntu-managed.py")"
case "$helper" in "$project_dir/"*) ;; *) echo "交互程序启动文件超出项目范围。" >&2; exit 1 ;; esac
exec "$python" -I "$helper" "$action" --runtime-root "$root" --managed-python "$python" "$@"
