"""Structured artifact references shared by sessions, rooms and runs."""

from __future__ import annotations

import mimetypes
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import Field

from mona.config.schema import Base
from mona.config.paths import get_agent_output_dir, get_stock_project_dir


class ArtifactRef(Base):
    """A path reference whose owner is explicit and independently resolvable."""

    id: str = Field(default_factory=lambda: f"artifact_{uuid.uuid4().hex}")
    owner_kind: Literal["agent", "product"]
    owner_id: str
    relative_path: str
    created_by_agent_id: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    product: str | None = None
    session_id: str | None = None
    room_id: str | None = None
    job_id: str | None = None
    workflow_run_id: str | None = None
    workflow_step_id: str | None = None
    size: int | None = None
    modified_at: datetime | None = None
    mime: str | None = None

    @classmethod
    def for_path(
        cls,
        *,
        owner_kind: Literal["agent", "product"],
        owner_id: str,
        root: Path,
        path: Path,
        created_by_agent_id: str,
        product: str | None = None,
        session_id: str | None = None,
        room_id: str | None = None,
        job_id: str | None = None,
        workflow_run_id: str | None = None,
        workflow_step_id: str | None = None,
    ) -> "ArtifactRef":
        root_resolved = Path(root).expanduser().resolve()
        path_resolved = Path(path).expanduser().resolve()
        try:
            relative = path_resolved.relative_to(root_resolved).as_posix()
        except ValueError as exc:
            raise ValueError("artifact path is outside its owner root") from exc
        stat = path_resolved.stat()
        return cls(
            owner_kind=owner_kind,
            owner_id=owner_id,
            relative_path=relative,
            created_by_agent_id=created_by_agent_id,
            product=product,
            session_id=session_id,
            room_id=room_id,
            job_id=job_id,
            workflow_run_id=workflow_run_id,
            workflow_step_id=workflow_step_id,
            size=stat.st_size,
            modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
            mime=mimetypes.guess_type(path_resolved.name)[0] or "application/octet-stream",
        )

    def owner_root(self, workspace: str | Path) -> Path:
        if self.owner_kind == "agent":
            return get_agent_output_dir(workspace, self.owner_id)
        if self.product == "stock" or self.product is None:
            return get_stock_project_dir(workspace, self.owner_id)
        raise ValueError(f"unsupported artifact product {self.product!r}")

    @property
    def uri(self) -> str:
        """Human/tool-facing compatibility URI; persistence uses the fields."""
        namespace = self.product or self.owner_kind
        return f"artifact://{namespace}/{self.owner_id}/{self.relative_path}"

    def resolve(self, workspace: str | Path) -> Path:
        """Resolve under the owner root and reject traversal/symlink escapes."""
        root = self.owner_root(workspace).resolve()
        rel = Path(self.relative_path)
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError("artifact path must be relative")
        target = (root / rel).resolve()
        target.relative_to(root)
        return target

    def as_file(self, workspace: str | Path) -> dict[str, Any]:
        """Return a UI file row without persisting an absolute path."""
        target = self.resolve(workspace)
        exists = target.is_file()
        size = self.size
        modified = self.modified_at
        if exists:
            stat = target.stat()
            size = stat.st_size
            modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        name = Path(self.relative_path).name
        return {
            "path": self.relative_path,
            "name": name,
            "size": size or 0,
            "size_human": _human_size(size or 0),
            "mime": self.mime or mimetypes.guess_type(name)[0] or "application/octet-stream",
            "modified_at": modified.isoformat() if modified else None,
            "missing": not exists,
            "artifact_ref": self.model_dump(mode="json"),
        }


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    value = float(size)
    for unit in ("KB", "MB", "GB"):
        value /= 1024
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}"
    return f"{value:.1f} GB"


def coerce_artifact_ref(raw: Any) -> ArtifactRef | None:
    if isinstance(raw, ArtifactRef):
        return raw
    if isinstance(raw, dict):
        try:
            return ArtifactRef.model_validate(raw)
        except Exception:
            return None
    return None
