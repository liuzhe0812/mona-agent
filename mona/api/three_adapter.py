"""Thin adapter for the img2threejs upstream skill.

Wraps upstream Python scripts with Windows-compatible invocation
(sys.executable + UTF-8) and standard project directory management.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


def _skill_root() -> Path:
    """Locate the img2threejs skill directory."""
    return Path(__file__).resolve().parent.parent / "skills" / "img2threejs"


# 与 forge/stage3_build/orchestrate_passes.py 的 DEFAULT_PASS_ORDER 保持一致。
# 仅在规格缺失时作为兜底；规格存在时一律以 sculptPipeline 为准。
DEFAULT_PASS_ORDER: list[str] = [
    "blockout",
    "structural-pass",
    "form-refinement",
    "material-pass",
    "surface-pass",
    "lighting-pass",
    "interaction-pass",
    "optimization-pass",
]

# 允许通过 /api/three/project/file 读取的项目产物
_ALLOWED_FILE_PREFIXES = ("references/", "renders/", "comparisons/", "reports/", "src/", "build/")
_ALLOWED_FILE_NAMES = {"meta.json", "assessment.json", "object-sculpt-spec.json", "candidate-spec.json"}

_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".js": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
}


class StaleCandidateError(Exception):
    """Raised when a candidate spec's baseline hash no longer matches."""


class ThreeAdapter:
    """Windows-compatible wrapper around img2threejs upstream scripts."""

    def __init__(self, workspace: Path | None = None) -> None:
        self.workspace = workspace
        self.skill_dir = _skill_root()

    def run_script(self, script_name: str, args: list[str]) -> dict | str:
        """Run an upstream script and return its stdout.

        Args:
            script_name: Script filename relative to forge/ (e.g. "probe_image.py").
            args: Command-line arguments for the script.

        Returns:
            Parsed JSON dict when stdout is valid JSON, otherwise raw string.

        Raises:
            RuntimeError: If the script exits with a non-zero code.
        """
        script_path = self._resolve_script(script_name)
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"

        result = subprocess.run(
            [sys.executable, str(script_path), *args],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"img2threejs script failed ({script_name}): {result.stderr.strip()}"
            )
        stdout = result.stdout.strip()
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return stdout

    def _resolve_script(self, script_name: str) -> Path:
        """Resolve script path within the skill's forge directory."""
        # Map short names to full paths
        candidates = [
            self.skill_dir / "forge" / "stage1_intake" / script_name,
            self.skill_dir / "forge" / "stage2_spec" / script_name,
            self.skill_dir / "forge" / "stage3_build" / script_name,
            self.skill_dir / "forge" / "stage4_review" / script_name,
            self.skill_dir / "forge" / script_name,
        ]
        for path in candidates:
            if path.is_file():
                return path
        raise FileNotFoundError(f"Script not found in skill: {script_name}")

    def create_project(self, name: str) -> Path:
        """Create a standard 3D project directory.

        Args:
            name: Project name (must be a valid directory name).

        Returns:
            Path to the created project directory.

        Raises:
            ValueError: If the project name is invalid.
            FileExistsError: If the project already exists.
        """
        project_dir = self._resolve_project_dir(name, must_exist=False)
        if project_dir.exists():
            raise FileExistsError(f"project already exists: {name}")

        for sub in ("references", "src", "build", "renders", "comparisons", "reports"):
            (project_dir / sub).mkdir(parents=True, exist_ok=True)

        meta = {
            "name": name,
            "version": 1,
            "createdAt": time.time(),
        }
        (project_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return project_dir

    def list_projects(self) -> list[dict]:
        """List all 3D projects in the workspace."""
        projects_dir = self._projects_root()
        if not projects_dir.is_dir():
            return []
        projects: list[dict] = []
        for d in sorted(projects_dir.iterdir()):
            if not d.is_dir() or d.name.startswith("_"):
                continue
            meta_file = d / "meta.json"
            meta: dict = {}
            if meta_file.is_file():
                try:
                    meta = json.loads(meta_file.read_text(encoding="utf-8"))
                except Exception:
                    pass
            projects.append({"name": d.name, "meta": meta})
        return projects

    def get_project(self, name: str) -> dict:
        """Get project metadata and status.

        Args:
            name: Project name.

        Returns:
            Dict with name, meta, and derived status fields.

        Raises:
            ValueError: If the project name is invalid.
            FileNotFoundError: If the project does not exist.
        """
        project_dir = self._resolve_project_dir(name)
        meta_file = project_dir / "meta.json"
        meta: dict = {}
        if meta_file.is_file():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {"name": name, "meta": meta}

    def delete_project(self, name: str) -> None:
        """Delete a 3D project directory.

        Args:
            name: Project name.

        Raises:
            ValueError: If the project name is invalid.
            FileNotFoundError: If the project does not exist.
        """
        project_dir = self._resolve_project_dir(name)
        import shutil
        shutil.rmtree(project_dir)

    def _project_dir(self, name: str) -> Path:
        """Resolve a validated project directory (must exist)."""
        return self._resolve_project_dir(name)

    @staticmethod
    def _load_json(path: Path) -> dict:
        if not path.is_file():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def _list_files(project_dir: Path, sub: str) -> list[dict]:
        folder = project_dir / sub
        if not folder.is_dir():
            return []
        files = [f for f in sorted(folder.iterdir()) if f.is_file()]
        return [{"name": f.name, "path": f"{sub}/{f.name}"} for f in files]

    def get_project_state(self, name: str) -> dict:
        """Aggregate project state derived from the spec (single source of truth).

        Stage statuses are derived from ``spec.sculptPipeline``; the frontend
        renders them directly and never maintains its own stage truth.
        """
        project_dir = self._project_dir(name)
        meta = self._load_json(project_dir / "meta.json")
        spec = self._load_json(project_dir / "object-sculpt-spec.json")

        pipeline = spec.get("sculptPipeline") if isinstance(spec.get("sculptPipeline"), dict) else {}
        pass_order = pipeline.get("passOrder")
        if not isinstance(pass_order, list) or not pass_order:
            pass_order = list(DEFAULT_PASS_ORDER)
        completed_raw = pipeline.get("completedPasses")
        completed = set(completed_raw) if isinstance(completed_raw, list) else set()
        current = pipeline.get("currentPass")
        if not isinstance(current, str) or not current:
            current = next((p for p in pass_order if p not in completed), "complete")
        blocked_reason = pipeline.get("blockedReason")
        blocked_reason = blocked_reason if isinstance(blocked_reason, str) else ""

        stages: list[dict] = []
        for pid in pass_order:
            if pid in completed:
                status = "passed"
            elif pid == current:
                status = "blocked" if blocked_reason else "running"
            else:
                status = "pending"
            stages.append({"id": pid, "status": status})

        components_raw = spec.get("componentTree")
        components = [
            {
                "id": str(c.get("id", "")),
                "name": str(c.get("name", "")),
                "role": str(c.get("role", "")),
                "primitive": str(c.get("primitive", "")),
            }
            for c in components_raw
            if isinstance(c, dict)
        ] if isinstance(components_raw, list) else []

        history_raw = spec.get("reviewHistory")
        last_review = history_raw[-1] if isinstance(history_raw, list) and history_raw else None

        candidate = self._load_json(project_dir / "candidate-spec.json")
        candidate_present = (project_dir / "candidate-spec.json").is_file()

        return {
            "name": name,
            "meta": meta,
            "specPresent": bool(spec),
            "specHash": self._spec_hash(spec) if spec else "",
            "stages": stages,
            "blockedReason": blocked_reason,
            "components": components,
            "lastReview": last_review,
            "references": self._list_files(project_dir, "references"),
            "renders": self._list_files(project_dir, "renders"),
            "comparisons": self._list_files(project_dir, "comparisons"),
            "reports": self._list_files(project_dir, "reports"),
            "candidatePresent": candidate_present,
            "candidateBaseHash": candidate.get("baseHash") if candidate_present else None,
            "sourcePresent": (project_dir / "src" / "createObjectModel.ts").is_file(),
        }

    @staticmethod
    def _spec_hash(spec: dict) -> str:
        """Stable SHA-256 over the canonical JSON of a spec."""
        payload = json.dumps(spec, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def candidate_diff(self, name: str) -> dict:
        """Field-level diff between the formal spec and the candidate spec.

        Returns:
            Dict with specHash, candidateBaseHash, stale flag and a capped
            list of {path, kind, before, after} change entries.

        Raises:
            ValueError: If the project name is invalid or no candidate exists.
            FileNotFoundError: If the project does not exist.
        """
        project_dir = self._project_dir(name)
        candidate_path = project_dir / "candidate-spec.json"
        if not candidate_path.is_file():
            raise ValueError("no candidate spec")
        candidate = self._load_json(candidate_path)
        spec = self._load_json(project_dir / "object-sculpt-spec.json")
        spec_hash = self._spec_hash(spec) if spec else ""
        base_hash = candidate.get("baseHash")
        new_spec = candidate.get("spec") if isinstance(candidate.get("spec"), dict) else {}
        changes: list[dict] = []
        self._walk_diff(spec, new_spec, "", changes)
        return {
            "specHash": spec_hash,
            "candidateBaseHash": base_hash,
            "stale": base_hash != spec_hash,
            "changes": changes[:500],
            "truncated": len(changes) > 500,
        }

    @classmethod
    def _walk_diff(cls, old: object, new: object, path: str, out: list[dict]) -> None:
        if isinstance(old, dict) and isinstance(new, dict):
            for key in old.keys() | new.keys():
                child = f"{path}.{key}" if path else str(key)
                if key not in old:
                    out.append({"path": child, "kind": "added", "before": None, "after": new[key]})
                elif key not in new:
                    out.append({"path": child, "kind": "removed", "before": old[key], "after": None})
                else:
                    cls._walk_diff(old[key], new[key], child, out)
            return
        if isinstance(old, list) and isinstance(new, list):
            for i in range(max(len(old), len(new))):
                child = f"{path}[{i}]"
                if i >= len(old):
                    out.append({"path": child, "kind": "added", "before": None, "after": new[i]})
                elif i >= len(new):
                    out.append({"path": child, "kind": "removed", "before": old[i], "after": None})
                else:
                    cls._walk_diff(old[i], new[i], child, out)
            return
        if old != new:
            out.append({"path": path, "kind": "changed", "before": old, "after": new})

    def apply_candidate_spec(self, name: str) -> None:
        """Atomically replace the formal spec with the candidate spec.

        The candidate records the formal spec hash it was generated against
        (``baseHash``). Apply re-checks that baseline and refuses to overwrite
        a formal spec that has moved on. The replacement is written to a temp
        file and ``os.replace``d so a failure never corrupts the formal spec.

        Raises:
            ValueError: If no candidate exists or it is malformed.
            StaleCandidateError: If the baseline hash no longer matches.
            FileNotFoundError: If the project does not exist.
        """
        project_dir = self._project_dir(name)
        candidate_path = project_dir / "candidate-spec.json"
        if not candidate_path.is_file():
            raise ValueError("no candidate spec")
        candidate = self._load_json(candidate_path)
        spec = self._load_json(project_dir / "object-sculpt-spec.json")
        current_hash = self._spec_hash(spec) if spec else ""
        if candidate.get("baseHash") != current_hash:
            raise StaleCandidateError("candidate baseline is stale")
        new_spec = candidate.get("spec")
        if not isinstance(new_spec, dict):
            raise ValueError("malformed candidate spec")

        target = project_dir / "object-sculpt-spec.json"
        tmp = project_dir / "object-sculpt-spec.json.tmp"
        tmp.write_text(json.dumps(new_spec, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, target)
        candidate_path.unlink(missing_ok=True)

    def discard_candidate_spec(self, name: str) -> None:
        """Delete the candidate spec without touching the formal spec."""
        project_dir = self._project_dir(name)
        (project_dir / "candidate-spec.json").unlink(missing_ok=True)

    def save_chat_id(self, name: str, chat_id: str) -> None:
        """Persist the WebSocket chat session ID in project meta.json."""
        project_dir = self._project_dir(name)
        meta = self._load_json(project_dir / "meta.json")
        if not isinstance(meta, dict):
            meta = {}
        meta["chatId"] = chat_id
        (project_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def read_project_file(self, name: str, rel_path: str) -> tuple[bytes, str]:
        """Read a whitelisted project artifact.

        Returns:
            (content, content_type) tuple.

        Raises:
            ValueError: If the path escapes the whitelist or project root.
            FileNotFoundError: If project or file does not exist.
        """
        project_dir = self._project_dir(name)
        normalized = rel_path.replace("\\", "/").lstrip("/")
        if ".." in normalized.split("/"):
            raise ValueError("invalid file path")
        allowed = normalized in _ALLOWED_FILE_NAMES or any(
            normalized.startswith(p) for p in _ALLOWED_FILE_PREFIXES
        )
        if not allowed:
            raise ValueError("file path not allowed")
        target = (project_dir / normalized).resolve()
        if not target.is_relative_to(project_dir.resolve()):
            raise ValueError("invalid file path")
        if not target.is_file():
            raise FileNotFoundError(f"file not found: {normalized}")
        content_type = _CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        return target.read_bytes(), content_type

    def save_render(self, name: str, data_url: str) -> Path:
        """Save a PNG data URL screenshot into the project's renders dir.

        Args:
            name: Project name.
            data_url: ``data:image/png;base64,...`` payload from the sandbox.

        Returns:
            Path to the written PNG file.

        Raises:
            ValueError: If the project name or data URL is invalid.
            FileNotFoundError: If the project does not exist.
        """
        prefix = "data:image/png;base64,"
        if not data_url.startswith(prefix):
            raise ValueError("invalid data url")
        try:
            payload = base64.b64decode(data_url[len(prefix):], validate=True)
        except Exception as e:
            raise ValueError("invalid data url") from e
        if not payload.startswith(b"\x89PNG"):
            raise ValueError("invalid data url")

        project_dir = self._resolve_project_dir(name)
        path = project_dir / "renders" / f"render-{int(time.time() * 1000)}.png"
        path.write_bytes(payload)
        return path

    _REFERENCE_MIME_EXT: dict[str, str] = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    _REFERENCE_MAX_BYTES = 20 * 1024 * 1024

    def save_reference(self, name: str, data_url: str, filename: str | None = None) -> Path:
        """Save an image data URL into the project's references dir.

        Accepts PNG/JPEG/WEBP/GIF. The file is written to
        ``three_projects/<name>/references/`` with a timestamped name
        (or a sanitized ``filename`` if provided).
        """
        project_dir = self._resolve_project_dir(name)

        mime, payload = self._decode_image_data_url(data_url)
        if len(payload) > self._REFERENCE_MAX_BYTES:
            raise ValueError("reference image too large (max 20MB)")

        ext = self._REFERENCE_MIME_EXT.get(mime, ".png")
        safe_base = "reference"
        if filename:
            base = "".join(c for c in filename if c.isalnum() or c in "-_") or "reference"
            safe_base = base[:40]
        path = project_dir / "references" / f"{safe_base}-{int(time.time() * 1000)}{ext}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def _decode_image_data_url(self, data_url: str) -> tuple[str, bytes]:
        """Decode a data URL into (mime, raw_bytes). Raises ValueError on bad input."""
        prefix_match = re.match(r"^data:([^;]+);base64,(.+)$", data_url, re.DOTALL)
        if not prefix_match:
            raise ValueError("invalid data url")
        mime = prefix_match.group(1).lower()
        if mime not in self._REFERENCE_MIME_EXT:
            raise ValueError(f"unsupported reference image type: {mime}")
        try:
            payload = base64.b64decode(prefix_match.group(2), validate=True)
        except Exception as e:
            raise ValueError("invalid data url") from e
        return mime, payload

    _NAME_MAX_LEN = 64
    # Windows 保留设备名（不区分大小写，且带扩展名也不允许）
    _WINDOWS_RESERVED = {
        "con", "prn", "aux", "nul",
        *(f"com{i}" for i in range(1, 10)),
        *(f"lpt{i}" for i in range(1, 10)),
    }
    # Windows 非法文件名字符 + 控制字符
    _INVALID_CHARS = re.compile('[<>:"|?*\\x00-\\x1f]')

    def _projects_root(self) -> Path:
        """Resolve the three_projects root directory."""
        if self.workspace:
            return self.workspace / "three_projects"
        return _skill_root().parent.parent.parent / "three_projects"

    def _validate_name(self, name: str) -> None:
        """Reject invalid project names.

        Guards against path traversal (``..``), self/parent references
        (``.``), Windows reserved device names, control characters, trailing
        dots/spaces and over-long names. ``Path("three_projects") / "."``
        resolves to the projects root itself — must never be accepted.
        """
        if not name or len(name) > self._NAME_MAX_LEN:
            raise ValueError("invalid project name")
        if name in (".", "..") or ".." in name or "/" in name or "\\" in name:
            raise ValueError("invalid project name")
        if name != name.strip() or name.endswith("."):
            raise ValueError("invalid project name")
        if self._INVALID_CHARS.search(name):
            raise ValueError("invalid project name")
        stem = name.split(".")[0].lower()
        if stem in self._WINDOWS_RESERVED:
            raise ValueError("invalid project name")

    def _resolve_project_dir(self, name: str, *, must_exist: bool = True) -> Path:
        """Resolve a project dir and prove it stays under the projects root."""
        self._validate_name(name)
        root = self._projects_root().resolve()
        project_dir = (root / name).resolve()
        if project_dir.parent != root:
            raise ValueError("invalid project name")
        if must_exist and not project_dir.is_dir():
            raise FileNotFoundError(f"project not found: {name}")
        return project_dir
