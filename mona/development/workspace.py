"""Project-scoped developer views. Workspace changes are not agent attribution."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
from pathlib import Path

from mona.development.contracts import Project
from mona.development.git_environment import git_command_env, require_git
from mona.development.store import ConflictError, DevelopmentError

MAX_TEXT_BYTES = 1_048_576
MAX_PROJECT_MEDIA_BYTES = 50 * 1024 * 1024
_PROJECT_MEDIA_TYPES = {
    ".aac": "audio/aac",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".mid": "audio/midi",
    ".midi": "audio/midi",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".ogv": "video/ogg",
    ".opus": "audio/ogg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".weba": "audio/webm",
    ".webm": "video/webm",
    ".webp": "image/webp",
}


def project_path(project: Project, relative: str = "", *, file: bool = False) -> Path:
    root = Path(project.root_path).resolve(strict=True)
    if str(root) != project.root_path or not root.is_dir():
        raise DevelopmentError("project_changed", "项目目录已变化，请重新打开项目。")
    value = Path(relative)
    if value.is_absolute() or value.drive or "\x00" in relative:
        raise DevelopmentError("invalid_path", "请使用当前项目内的相对路径。")
    target = (root / value).resolve(strict=True)
    if not target.is_relative_to(root):
        raise DevelopmentError("outside_project", "该路径指向项目外，未读取或修改。")
    if file and not target.is_file():
        raise DevelopmentError("not_file", "请选择项目中的文件。")
    return target


def directory_entries(project: Project, relative: str = "", offset: int = 0, limit: int = 200) -> dict:
    if offset < 0 or not 1 <= limit <= 500:
        raise DevelopmentError("invalid_page", "目录分页参数无效。")
    directory = project_path(project, relative)
    if not directory.is_dir():
        raise DevelopmentError("not_directory", "请选择项目中的目录。")
    root = Path(project.root_path)
    # One level only. Hidden and build files remain visible; never follow links.
    entries = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.casefold()))
    rows = []
    for child in entries[offset:offset + limit]:
        link = child.is_symlink() or (hasattr(child, "is_junction") and child.is_junction())
        rows.append({"name": child.name, "path": child.relative_to(root).as_posix(),
                     "kind": "link" if link else "directory" if child.is_dir() else "file"})
    end = offset + len(rows)
    return {"entries": rows, "nextOffset": end if end < len(entries) else None, "total": len(entries)}


def read_project_file(project: Project, relative: str) -> dict:
    target = project_path(project, relative, file=True)
    with target.open("rb") as stream:
        raw = stream.read(MAX_TEXT_BYTES + 1)
    if len(raw) > MAX_TEXT_BYTES:
        raise DevelopmentError("file_too_large", "文件超过编辑器读取上限，请使用外部编辑器或在会话中按范围读取。")
    if b"\x00" in raw:
        raise DevelopmentError("binary_file", "此文件不是可直接编辑的文本。")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeError as exc:
        raise DevelopmentError("unsupported_encoding", "当前编辑器只编辑 UTF-8 文本，原文件未改变。") from exc
    return {"path": relative, "content": text, "sha256": hashlib.sha256(raw).hexdigest(),
            "bom": raw.startswith(b"\xef\xbb\xbf")}


def read_project_media(project: Project, relative: str) -> tuple[bytes, str]:
    if relative.startswith("mona-media:"):
        from mona.development.output_media import read_generated_image
        return read_generated_image(project, relative)
    target = project_path(project, relative, file=True)
    content_type = _PROJECT_MEDIA_TYPES.get(target.suffix.lower())
    if content_type is None:
        raise DevelopmentError("unsupported_media", "此文件类型不支持在会话中预览。")

    if target.stat().st_size > MAX_PROJECT_MEDIA_BYTES:
        raise DevelopmentError("media_too_large", "媒体文件超过 50 MiB 预览上限。")
    with target.open("rb") as stream:
        raw = stream.read(MAX_PROJECT_MEDIA_BYTES + 1)
    if len(raw) > MAX_PROJECT_MEDIA_BYTES:
        raise DevelopmentError("media_too_large", "媒体文件超过 50 MiB 预览上限。")
    return raw, content_type


def save_project_file(project: Project, relative: str, content: str, expected_sha: str) -> dict:
    target = project_path(project, relative, file=True)
    original = target.read_bytes()
    if hashlib.sha256(original).hexdigest() != expected_sha:
        raise ConflictError("文件已被其他操作修改。你的草稿仍保留，请重新读取后合并。")
    raw = (b"\xef\xbb\xbf" if original.startswith(b"\xef\xbb\xbf") else b"") + content.encode("utf-8")
    if len(raw) > MAX_TEXT_BYTES:
        raise DevelopmentError("file_too_large", "文本超过保存上限，原文件未修改。")
    fd, name = tempfile.mkstemp(prefix=".mona-edit-", dir=target.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, target.stat().st_mode)
        # Recheck immediately before replacement; this is not a project-wide lock.
        if project_path(project, relative, file=True) != target or hashlib.sha256(target.read_bytes()).hexdigest() != expected_sha:
            raise ConflictError("保存前文件已变化，未覆盖。")
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return {"path": relative, "content": content, "sha256": hashlib.sha256(raw).hexdigest(),
            "bom": raw.startswith(b"\xef\xbb\xbf")}


async def _git(root: Path, *args: str, checking_repository: bool = False) -> tuple[int, bytes]:
    executable = await require_git()
    try:
        process = await asyncio.create_subprocess_exec(
            executable, "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", *args, cwd=str(root),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=git_command_env(),
        )
    except OSError as exc:
        raise DevelopmentError("git_unavailable", "Git 无法启动，请重新检测；未执行 Git 操作。") from exc
    async def bounded(stream) -> bytes:
        chunks, size = [], 0
        while chunk := await stream.read(65536):
            size += len(chunk)
            if size > 2 * MAX_TEXT_BYTES:
                raise DevelopmentError("git_result_too_large", "变更结果过大，请缩小到单个文件查看。")
            chunks.append(chunk)
        return b"".join(chunks)
    readers = [asyncio.create_task(bounded(stream)) for stream in (process.stdout, process.stderr)]
    async def collect() -> tuple[bytes, bytes]:
        out, err = await asyncio.gather(*readers)
        await process.wait()
        return out, err
    try:
        out, err = await asyncio.wait_for(collect(), 15)
        if checking_repository and process.returncode and b"not a git repository" not in err.lower():
            raise DevelopmentError("git_failed", "Git 已检测到，但无法读取仓库；请检查目录权限或仓库配置。")
        return process.returncode, out
    except (asyncio.CancelledError, asyncio.TimeoutError, DevelopmentError):
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        if process.returncode is None:
            process.kill()
        # Drain pipes before waiting; paused readers can block wait even after kill.
        await process.communicate()
        raise


async def git_summary(project: Project, *, refresh: bool = False) -> dict:
    root = project_path(project)
    try:
        await require_git(refresh=refresh)
        return await _git_summary(root)
    except DevelopmentError as exc:
        if exc.code != "git_unavailable":
            raise
        return {"available": False, "reasonCode": "git_unavailable", "reason": str(exc), "files": []}


async def _git_summary(root: Path) -> dict:
    code, repository_bytes = await _git(root, "rev-parse", "--show-toplevel", checking_repository=True)
    if code:
        return {"available": False, "reasonCode": "not_repository", "reason": "当前目录不是 Git 仓库。", "files": []}
    repository = Path(repository_bytes.decode("utf-8").strip()).resolve()
    code, raw = await _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".")
    if code:
        raise DevelopmentError("git_failed", "无法读取工作区变更，请检查仓库状态。")
    files, parts, index = [], raw.split(b"\x00"), 0
    while index < len(parts):
        part = parts[index]
        index += 1
        if not part:
            continue
        status = part[:2].decode("ascii", "replace")
        reported = repository / part[3:].decode("utf-8", "replace")
        if not reported.is_relative_to(root):
            raise DevelopmentError("git_scope_mismatch", "仓库返回了项目范围之外的路径，未展示为当前项目文件。")
        row = {"status": status, "path": reported.relative_to(root).as_posix()}
        if "R" in status or "C" in status:
            row["previousPath"] = parts[index].decode("utf-8", "replace")
            index += 1
        files.append(row)
    branch_code, branch = await _git(root, "symbolic-ref", "--quiet", "--short", "HEAD")
    if branch_code:
        _, branch = await _git(root, "rev-parse", "--short", "HEAD")
    has_head, _ = await _git(root, "rev-parse", "--verify", "HEAD")
    tracking = None
    ahead = behind = 0
    if not branch_code and not has_head:
        tracking_code, tracking_raw = await _git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
        if not tracking_code:
            tracking = tracking_raw.decode().strip()
            compare_code, counts = await _git(root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
            if compare_code:
                raise DevelopmentError("git_failed", "无法读取分支同步状态。")
            ahead, behind = map(int, counts.split())
    flags = ("--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv")
    if has_head == 0:
        stats_code, stats = await _git(root, "diff", *flags, "HEAD", "--", ".")
    else:
        stats_code, stats = await _git(root, "diff", "--cached", *flags, "--", ".")
        work_code, work_stats = await _git(root, "diff", *flags, "--", ".")
        stats_code = stats_code or work_code
        stats += work_stats
    if stats_code:
        raise DevelopmentError("git_failed", "无法读取变更统计，请刷新仓库状态。")
    additions = deletions = binary = 0
    for record in stats.split(b"\x00"):
        if not record:
            continue
        added, removed, _ = record.split(b"\t", 2)
        if added == b"-" or removed == b"-":
            binary += 1
        else:
            additions += int(added)
            deletions += int(removed)
    return {"available": True, "branch": branch.decode("utf-8", "replace").strip(),
            "trackingBranch": tracking, "ahead": ahead, "behind": behind,
            "canPush": not branch_code and not has_head and (tracking is None or ahead > 0),
            "files": files, "attribution": "workspace", "count": len(files),
            "additions": additions, "deletions": deletions, "binaryFiles": binary,
            "untrackedFiles": sum(row["status"] == "??" for row in files),
            "statsScope": "tracked" if has_head == 0 else "staged_and_unstaged"}


async def git_diff(project: Project, relative: str = "") -> dict:
    root = project_path(project)
    if relative:
        # Deleted paths need not exist, but must still be contained in the project.
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or Path(relative).is_absolute():
            raise DevelopmentError("outside_project", "差异路径不属于当前项目。")
    # Review identities and structured diff rows cannot depend on terminal styling.
    flags = ("--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--relative")
    code, raw = await _git(root, "diff", *flags, "HEAD", "--", relative or ".")
    if code:
        # An unborn repository has no HEAD; show staged and unstaged evidence.
        staged_code, staged = await _git(root, "diff", "--cached", *flags, "--", relative or ".")
        code, unstaged = await _git(root, "diff", *flags, "--", relative or ".")
        raw = staged + unstaged
        code = code or staged_code
    if code:
        raise DevelopmentError("git_failed", "无法读取差异，请检查仓库状态。")
    from mona.development.untracked_diff import untracked_diff
    raw += await untracked_diff(root, relative, 2 * MAX_TEXT_BYTES - len(raw))
    return {"diff": raw.decode("utf-8", "replace"), "sha256": hashlib.sha256(raw).hexdigest(), "attribution": "workspace"}
