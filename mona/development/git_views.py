"""Read-only Git previews and history for the development controls."""
from __future__ import annotations

import re

from mona.development.git_operations import digest, git, read_git
from mona.development.store import DevelopmentError


def numstats(raw: bytes) -> dict[str, tuple[int, int]]:
    result = {}
    for row in raw.split(b"\0"):
        if not row:
            continue
        added, removed, path = row.split(b"\t", 2)
        result[path.decode("utf-8")] = (int(added) if added.isdigit() else 0, int(removed) if removed.isdigit() else 0)
    return result


async def preview(service, session_id: str, include_unstaged: bool) -> dict:
    context = await service.context(session_id)
    _, root = await service._root(session_id)
    staged = [row for row in context["files"] if row["status"][0] not in {" ", "?"}]
    unstaged = [row for row in context["files"] if row["status"][1] != " "]
    staged_count, unstaged_count = len(staged), len(unstaged)
    flags = ["--no-ext-diff", "--no-textconv", "--numstat", "-z", "--no-renames"]
    cached_stats = numstats(await read_git(root, "diff", "--cached", *flags))
    working_stats = numstats(await read_git(root, "diff", *flags)) if include_unstaged else {}
    files = []
    for group, is_staged, stats in [(unstaged if include_unstaged else [], False, working_stats), (staged, True, cached_stats)]:
        for row in group:
            counts = stats.get(row["path"], (0, 0))
            if row["status"] == "??":
                service._file(root, row["path"])
                with (root / row["path"]).open("rb") as stream:
                    data = stream.read(2_097_153)
                if len(data) <= 2_097_152 and b"\0" not in data:
                    counts = (len(data.splitlines()), 0)
            files.append({**row, "staged": is_staged, "unstaged": not is_staged,
                "additions": counts[0], "deletions": counts[1]})
    _, name, _ = await git(root, "config", "--get", "user.name")
    _, email, _ = await git(root, "config", "--get", "user.email")
    code, upstream, _ = await git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    tracking = None if code else upstream.decode().strip()
    ahead = behind = 0
    if tracking:
        counts = (await read_git(root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")).split()
        ahead, behind = map(int, counts)
    paths = sorted({row["path"] for row in files})
    signature = await service._signature(root, "commit", paths, "", "", include_unstaged=include_unstaged)
    remote_urls = await read_git(root, "remote", "get-url", "--push", "--all", context["defaultRemote"]) if context["defaultRemote"] else b""
    signature["pushTarget"] = digest([context["defaultRemote"], context["defaultBranch"], remote_urls.decode()])
    return {**context, "files": files, "identity": {"name": name.decode().strip(), "email": email.decode().strip()},
        "trackingBranch": tracking, "ahead": ahead, "behind": behind,
        "canPush": bool(context["head"] and context["branch"] and (not tracking or ahead > 0)),
        "stagedCount": staged_count, "unstagedCount": unstaged_count,
        "additions": sum(row["additions"] for row in files), "deletions": sum(row["deletions"] for row in files),
        "contextToken": digest(signature), "includeUnstaged": include_unstaged}


def commits(raw: bytes) -> list[dict]:
    fields = raw.decode("utf-8").split("\0")
    result = []
    for offset in range(0, len(fields) - 5, 6):
        sha, parents, decorations, subject, author, timestamp = fields[offset:offset + 6]
        refs = []
        for ref in filter(None, decorations.split(", ")):
            if ref.startswith("HEAD -> "):
                refs.extend([{"name": "HEAD", "kind": "head"}, {"name": ref[8:].removeprefix("refs/heads/"), "kind": "branch"}])
            else:
                kind = "tag" if ref.startswith("tag: ") else "head" if ref == "HEAD" else "remote" if ref.startswith("refs/remotes/") else "branch"
                refs.append({"name": ref.removeprefix("tag: ").removeprefix("refs/tags/").removeprefix("refs/heads/").removeprefix("refs/remotes/"), "kind": kind})
        result.append({"hash": sha.strip(), "parents": parents.split(), "refs": refs, "subject": subject,
            "authorName": author or None, "authoredAtMs": int(timestamp) * 1000 if timestamp.isdigit() else None})
    return result


FORMAT = "%H%x00%P%x00%D%x00%s%x00%an%x00%at%x00"


async def graph(service, session_id: str, skip: int) -> dict:
    _, root = await service._root(session_id)
    if not (await service._identity(root))["head"]:
        return {"commits": [], "hasMore": False}
    rows = commits(await read_git(root, "log", "--all", "--date-order", "--decorate=full", f"--format={FORMAT}", "--max-count=51", f"--skip={skip}"))
    return {"commits": rows[:50], "hasMore": len(rows) > 50}


async def commit_detail(service, session_id: str, sha: str, path: str | None) -> dict:
    if not re.fullmatch(r"[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?", sha):
        raise DevelopmentError("invalid_commit", "请选择历史中的提交。")
    _, root = await service._root(session_id)
    metadata = commits(await read_git(root, "show", "-s", "--decorate=full", f"--format={FORMAT}", sha))[0]
    body = (await read_git(root, "show", "-s", "--format=%B", sha)).decode()
    stats = numstats(await read_git(root, "show", "--format=", "--first-parent", "--numstat", "-z", "--no-renames", sha))
    names = (await read_git(root, "show", "--format=", "--first-parent", "--name-status", "-z", "--no-renames", sha)).split(b"\0")
    statuses = {names[index + 1].decode(): names[index].decode().strip() for index in range(0, len(names) - 1, 2) if names[index]}
    files = [{"path": name, "status": statuses.get(name, "M"), "additions": value[0], "deletions": value[1]} for name, value in stats.items()]
    if path is not None and path not in stats:
        raise DevelopmentError("invalid_git_path", "该文件不属于所选提交。")
    args = ["show", "--format=", "--first-parent", "--no-ext-diff", "--no-textconv", "--no-renames", sha, "--"]
    if path is not None:
        args.append(path)
    diff = (await read_git(root, *args)).decode("utf-8", errors="replace") if path is not None else ""
    return {"commit": metadata, "body": body, "files": files, "diff": diff}
