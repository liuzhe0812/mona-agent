"""Flowchart (draw.io) runtime detection and download manager.

Detects whether the draw.io webapp is provisioned; lazily downloads the
static webapp from the ``jgraph/drawio`` GitHub release into
``~/.mona/runtime/drawio/``.

The draw.io webapp is pure static files served at ``/drawio/*``. Only the
``src/main/webapp/`` subset of the release tarball is extracted; build
metadata, tests and App Store integration directories are skipped.
"""

from __future__ import annotations

import shutil
import tarfile
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

import aiohttp
from loguru import logger
from pydantic import BaseModel

from mona.security.network import validate_url_target

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ("FlowchartRuntime", "get_flowchart_runtime")

# Runtime root: ~/.mona/runtime/
RUNTIME_ROOT = Path.home() / ".mona" / "runtime"

# GitHub API + tarball templates.
GITHUB_RELEASE_API = "https://api.github.com/repos/jgraph/drawio/releases/latest"
GITHUB_TARBALL_TEMPLATE = (
    "https://github.com/jgraph/drawio/archive/refs/tags/{tag}.tar.gz"
)

# Fixed fallback version (used only if the GitHub API is unreachable).
FIXED_VERSION = "v30.2.7"

# Marker present in the packaged placeholder index.html.
_PLACEHOLDER_MARKER = "pending install"

# Top-level entries under src/main/webapp/ to keep. Everything else
# (com/, mxgraph/, test/, examples/, doc/, ...) is skipped during extraction.
_KEEP_ENTRIES = frozenset(
    {
        "index.html",
        "js",
        "css",
        "stencils",
        "shapes",
        "styles",
        "resources",
        "img",
    }
)

# Chunk size for streaming downloads.
_DOWNLOAD_CHUNK = 1 << 16  # 64 KiB


class ComponentStatus(BaseModel):
    """Status of a single runtime dependency."""

    ok: bool
    version: str | None = None
    path: str | None = None
    error: str | None = None


def _packaged_drawio_dir() -> Path:
    """Return the path to the packaged fallback webapp (mona/static/drawio/)."""
    return Path(__file__).resolve().parent.parent / "static" / "drawio"


@lru_cache(maxsize=1)
def get_flowchart_runtime() -> FlowchartRuntime:
    """Return the cached :class:`FlowchartRuntime` singleton."""
    return FlowchartRuntime()


class FlowchartRuntime:
    """Detect and provision the draw.io webapp for flowchart rendering."""

    def __init__(self, runtime_root: Path | None = None) -> None:
        self.root = runtime_root or RUNTIME_ROOT

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    def _component_dir(self) -> Path:
        return self.root / "drawio"

    def _version_file(self) -> Path:
        return self._component_dir() / ".version"

    @staticmethod
    def _is_placeholder(index_html: Path) -> bool:
        """Return True if ``index.html`` is the packaged placeholder."""
        try:
            content = index_html.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return True
        return _PLACEHOLDER_MARKER in content

    def _read_installed_version(self) -> str | None:
        v = self._version_file()
        if v.is_file():
            try:
                return v.read_text(encoding="utf-8").strip() or None
            except OSError:
                return None
        return None

    # ------------------------------------------------------------------
    # Public path getter
    # ------------------------------------------------------------------

    def get_drawio_path(self) -> Path | None:
        """Return the draw.io webapp directory path.

        Prefers a user-downloaded runtime at ``~/.mona/runtime/drawio/``;
        falls back to the packaged ``mona/static/drawio/``. Returns ``None``
        if neither location has an ``index.html``.
        """
        runtime_dir = self._component_dir()
        index_html = runtime_dir / "index.html"
        if index_html.is_file() and not self._is_placeholder(index_html):
            return runtime_dir
        packaged = _packaged_drawio_dir()
        if (packaged / "index.html").is_file():
            return packaged
        return None

    # ------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------

    def _check_drawio(self) -> ComponentStatus:
        """Check whether the draw.io webapp is ready to serve."""
        runtime_dir = self._component_dir()
        index_html = runtime_dir / "index.html"
        if index_html.is_file() and not self._is_placeholder(index_html):
            return ComponentStatus(
                ok=True,
                version=self._read_installed_version(),
                path=str(runtime_dir),
            )
        # Fall back to the packaged static dir if it ships a real webapp.
        packaged = _packaged_drawio_dir()
        packaged_index = packaged / "index.html"
        if packaged_index.is_file() and not self._is_placeholder(packaged_index):
            return ComponentStatus(ok=True, path=str(packaged))
        # Not ready: report the placeholder/missing state for diagnostics.
        if index_html.is_file():
            return ComponentStatus(
                ok=False,
                path=str(runtime_dir),
                error="draw.io webapp is a placeholder; download required",
            )
        if packaged_index.is_file():
            return ComponentStatus(
                ok=False,
                path=str(packaged),
                error="draw.io webapp is a placeholder; download required",
            )
        return ComponentStatus(ok=False, error="draw.io webapp not found")

    def check(self) -> dict:
        """Detect whether draw.io is ready.

        Returns ``{"drawio": {ok, version, path, error}}``.
        """
        return {"drawio": self._check_drawio().model_dump()}

    # ------------------------------------------------------------------
    # Download / provisioning
    # ------------------------------------------------------------------

    async def ensure_runtime(
        self, progress_cb: "Callable[[int, int], None] | None" = None
    ) -> dict:
        """Download and extract the draw.io webapp into ``~/.mona/runtime/drawio/``.

        Args:
            progress_cb: Optional callback ``(downloaded_bytes, total_bytes)``
                used to report download progress.

        Returns a dict with ``ok`` and either ``path``/``version`` or ``error``.
        """
        # Already provisioned with a real webapp?
        status = self._check_drawio()
        if status.ok:
            return {
                "ok": True,
                "path": status.path,
                "version": status.version,
                "cached": True,
            }

        tag = await self._resolve_latest_tag()
        tarball_url = GITHUB_TARBALL_TEMPLATE.format(tag=tag)
        logger.info("Provisioning draw.io webapp {} from {}", tag, tarball_url)

        dest = self._component_dir()
        # Clear any prior placeholder/partial contents so extraction is clean.
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True, exist_ok=True)

        # Download to a temp file outside ``dest`` so we can safely clear dest.
        tmp_tar = Path(tempfile.gettempdir()) / "mona-drawio.tarball.tar.gz"
        try:
            await self._download(tarball_url, tmp_tar, progress_cb)
            self._extract_webapp(tmp_tar, dest)
        finally:
            tmp_tar.unlink(missing_ok=True)

        index_html = dest / "index.html"
        if not index_html.is_file() or self._is_placeholder(index_html):
            return {"ok": False, "error": "draw.io webapp extraction failed"}
        self._version_file().write_text(tag, encoding="utf-8")
        logger.info("draw.io webapp {} provisioned at {}", tag, dest)
        return {"ok": True, "path": str(dest), "version": tag}

    async def _resolve_latest_tag(self) -> str:
        """Fetch the latest release tag from the GitHub API.

        Falls back to :data:`FIXED_VERSION` on any error.
        """
        ok, err = validate_url_target(GITHUB_RELEASE_API)
        if not ok:
            logger.warning(
                "GitHub API blocked by SSRF guard: {} - using fixed tag {}", err, FIXED_VERSION
            )
            return FIXED_VERSION
        timeout = aiohttp.ClientTimeout(total=30)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(
                    GITHUB_RELEASE_API,
                    headers={
                        "Accept": "application/vnd.github+json",
                        "User-Agent": "Mona-Desktop",
                    },
                    allow_redirects=True,
                ) as resp:
                    resp.raise_for_status()
                    data = await resp.json(content_type=None)
                    tag = str(data.get("tag_name") or "").strip()
                    if tag:
                        return tag
                    logger.warning(
                        "GitHub API returned empty tag_name - using fixed tag {}", FIXED_VERSION
                    )
        except Exception as exc:
            logger.warning(
                "Failed to query GitHub latest release: {} - using fixed tag {}", exc, FIXED_VERSION
            )
        return FIXED_VERSION

    async def _download(
        self,
        url: str,
        dest: Path,
        progress_cb: "Callable[[int, int], None] | None",
    ) -> None:
        ok, err = validate_url_target(url)
        if not ok:
            raise RuntimeError(f"URL blocked by SSRF guard: {err}")
        timeout = aiohttp.ClientTimeout(total=600)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("Content-Length", "0"))
                downloaded = 0
                with open(dest, "wb") as f:
                    async for chunk in resp.content.iter_chunked(_DOWNLOAD_CHUNK):
                        f.write(chunk)
                        downloaded += len(chunk)
                        if progress_cb:
                            progress_cb(downloaded, total)
        logger.info("Downloaded {} -> {}", url, dest)

    @staticmethod
    def _extract_webapp(tar_path: Path, dest: Path) -> None:
        """Extract only the webapp subset of the drawio tarball into ``dest``.

        The tarball layout is ``<top>/src/main/webapp/...``. Only the
        whitelisted top-level entries under ``webapp/`` are extracted; the
        rest (``com/``, ``mxgraph/``, ``test/``, ``examples/``, ``doc/``) are
        skipped. Path traversal entries are rejected.
        """
        with tarfile.open(tar_path, mode="r:gz") as tar:
            members = tar.getmembers()
            if not members:
                raise RuntimeError("drawio tarball is empty")

            # Locate the webapp prefix robustly (the top-level dir name varies
            # by tag, e.g. ``drawio-v30.2.7``).
            webapp_prefix = ""
            marker = "/src/main/webapp/"
            for m in members:
                idx = m.name.find(marker)
                if idx != -1:
                    webapp_prefix = m.name[: idx + len(marker)]
                    break
            if not webapp_prefix:
                raise RuntimeError("drawio tarball has no src/main/webapp/ directory")

            dest_resolved = dest.resolve()
            for member in members:
                name = member.name
                if not name.startswith(webapp_prefix):
                    continue
                rel = name[len(webapp_prefix):]
                if not rel:
                    continue
                first = rel.split("/", 1)[0]
                if first not in _KEEP_ENTRIES:
                    continue
                target = dest / rel
                # Guard against path traversal (e.g. rel containing '..').
                try:
                    target.resolve().relative_to(dest_resolved)
                except ValueError:
                    logger.warning("Skipping unsafe tarball path: {}", name)
                    continue
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    src = tar.extractfile(member)
                    if src is None:
                        continue
                    with open(target, "wb") as out:
                        while True:
                            chunk = src.read(_DOWNLOAD_CHUNK)
                            if not chunk:
                                break
                            out.write(chunk)
                # Symlinks, hardlinks and other special types are skipped.
