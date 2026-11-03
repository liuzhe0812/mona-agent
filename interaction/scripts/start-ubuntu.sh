#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
venv_python="$project_dir/.venv/bin/python"

if [[ ! -x "$venv_python" ]]; then
    python="${MONA_INTERACTION_PYTHON:-python3}"
    "$python" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' || {
        echo "Python 3.11 or later is required." >&2
        exit 1
    }
    "$python" -m venv "$project_dir/.venv"
fi

"$venv_python" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' || {
    echo "The project virtual environment requires Python 3.11 or later." >&2
    exit 1
}
"$venv_python" -m pip install -e "$project_dir"
echo "Open http://127.0.0.1:17880/ . Press Ctrl+C to stop."
exec "$venv_python" -m mona_interaction serve --host 127.0.0.1 --port 17880 "$@"
