"""Keep one previous version when retiring Mona's private memory Git stores."""

from __future__ import annotations

import os
import shutil
import stat
import tempfile
from pathlib import Path

from loguru import logger

from mona.utils.prompt_templates import persona_content

_MEMORY_FILES = ("SOUL.md", "MEMORY.md")
_LEGACY_FILES = frozenset({".gitignore", *_MEMORY_FILES, "USER.md", "AGENTS.md", ".dream_cursor"})
_LEGACY_PATHS = frozenset(name.encode("utf-8") for name in _LEGACY_FILES)
_MONA_AUTHOR = b"mona <mona@dream>"


def write_text_atomic(path: Path, content: str) -> None:
    """Replace text only after its complete temporary file reaches disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".agent_", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _direct_child(root: Path, path: Path) -> bool:
    return not path.is_symlink() and path.resolve() == root / path.name


def migrate_legacy_memory_versions(memory_dir: Path, current: dict[str, str]) -> None:
    """Replace only a verified Mona-owned Git store with per-file previous copies."""
    root = memory_dir.resolve()
    git_dir = memory_dir / ".git"
    if not git_dir.exists():
        return
    if not git_dir.is_dir() or not _direct_child(root, git_dir):
        logger.warning("Keeping linked or external memory Git metadata at {}", git_dir)
        return

    from dulwich.errors import NotGitRepository
    from dulwich.repo import Repo

    from mona.utils.gitstore import GitStore

    try:
        repository = Repo(str(root))
    except NotGitRepository:
        logger.warning("Keeping unrecognized memory Git metadata at {}", git_dir)
        return
    previous: dict[str, str] = {}
    with repository as repo:
        head = repo.refs.read_ref(b"HEAD")
        allowed_refs = {b"HEAD"}
        if head and head.startswith(b"ref: "):
            allowed_refs.add(head[5:])
        if not head or set(repo.refs.keys()) - allowed_refs or any(
            section[0] == b"remote" for section in repo.get_config().sections()
        ):
            logger.warning("Keeping memory Git store with user-managed references at {}", root)
            return
        try:
            sha = repo.head()
        except KeyError:
            logger.warning("Keeping memory Git store without saved versions at {}", root)
            return
        while sha:
            commit = repo[sha]
            if commit.type_name != b"commit":
                logger.warning("Keeping memory Git store with a non-commit head at {}", root)
                return
            tree = repo[commit.tree]
            if (
                commit.author != _MONA_AUTHOR
                or commit.committer != _MONA_AUTHOR
                or len(commit.parents) > 1
                or any(
                    entry.path not in _LEGACY_PATHS or not stat.S_ISREG(entry.mode)
                    for entry in tree.iteritems()
                )
            ):
                logger.warning("Keeping Git store that is not exclusively Mona memory at {}", root)
                return
            for filename in _MEMORY_FILES:
                if filename in previous:
                    continue
                content = GitStore._read_blob_from_tree(repo, tree, filename)
                if filename == "SOUL.md":
                    rules = GitStore._read_blob_from_tree(repo, tree, "AGENTS.md")
                    if content is not None or rules is not None:
                        content = persona_content(content or "", rules or "")
                if content is not None and content != current.get(filename, ""):
                    previous[filename] = content
            if not commit.parents:
                if commit.message.strip() != b"init: mona memory store":
                    logger.warning("Keeping Git store with a non-Mona root commit at {}", root)
                    return
                break
            sha = commit.parents[0]

    ignore = memory_dir / ".gitignore"
    generated_ignore = False
    if ignore.is_file() and _direct_child(root, ignore):
        lines = ignore.read_text(encoding="utf-8").splitlines()
        generated_ignore = (
            len(lines) >= 2
            and lines[0] == "/*"
            and lines[-1] == "!.gitignore"
            and all(line in {f"!{name}" for name in _LEGACY_FILES} for line in lines[1:-1])
        )
    for filename, content in previous.items():
        backup = memory_dir / f"{filename}.previous"
        if not backup.exists() and not backup.is_symlink():
            write_text_atomic(backup, content)

    if not _direct_child(root, git_dir):
        raise ValueError("memory Git metadata moved outside its private directory during migration")
    shutil.rmtree(git_dir)
    if generated_ignore and _direct_child(root, ignore):
        ignore.unlink()
    logger.info("Replaced legacy memory Git history with previous versions at {}", root)
