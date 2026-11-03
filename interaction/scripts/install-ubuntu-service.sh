#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
venv_python="$project_dir/.venv/bin/python"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

systemctl --user show-environment >/dev/null

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

"$venv_python" - "$project_dir" "$config_home/systemd/user" <<'PY'
from pathlib import Path
import sys

project = Path(sys.argv[1])
destination = Path(sys.argv[2]) / "mona-interaction.service"
executable = str(project / ".venv/bin/python")
if any(ord(char) < 32 or ord(char) == 127 for char in executable):
    raise SystemExit("The project path cannot contain control characters.")
executable = executable.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
template = (project / "deploy/mona-interaction.service").read_text(encoding="utf-8")
marker = "# Installed and populated by scripts/install-ubuntu-service.sh.\n"
if destination.is_symlink() or (
    destination.exists() and not destination.read_text(encoding="utf-8").startswith(marker)
):
    raise SystemExit(f"Refusing to overwrite an existing service: {destination}")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(
    template.replace("@PYTHON_EXECUTABLE@", f'":{executable}"'), encoding="utf-8"
)
PY

systemctl --user daemon-reload
systemctl --user enable --now mona-interaction.service
echo "Service enabled and start requested. Check: systemctl --user status mona-interaction.service"
