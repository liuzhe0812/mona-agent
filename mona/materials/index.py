"""SQLite FTS5 chunk index for the materials library.

索引单位是结构化 segment（页/幻灯片/工作表/标题），而非整份 markdown。
事实源是 `text/*.md` 与 `wiki/*.md` 文件；索引是可重建的派生数据，
由 reconciliation（services 进程）写入，由 knowledge_search（gateway 进程）读取。
多进程并发通过 WAL 模式 + busy timeout 保证。
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from loguru import logger

from mona.materials.frontmatter import _parse_frontmatter
from mona.materials.search import _extract_snippet

_SEG_MARKER_RE = re.compile(r"^<!-- seg (\{[^}]*\}) -->[ \t]*$", re.MULTILINE)

_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  chunk_id UNINDEXED,
  material_id UNINDEXED,
  title UNINDEXED,
  raw_path UNINDEXED,
  kind UNINDEXED,
  seg_kind UNINDEXED,
  location UNINDEXED,
  label UNINDEXED,
  sha256 UNINDEXED,
  size UNINDEXED,
  mtime_ns UNINDEXED,
  stale_flag UNINDEXED,
  seq UNINDEXED,
  content,
  tokenize='trigram'
);
"""

# derived（AI wiki）chunk 的相关性降权，避免摘要挤掉原文
_DERIVED_SCORE_FACTOR = 0.5

# trigram tokenizer 的最小查询长度；更短的 token 走子串回退
_TRIGRAM_MIN = 3


class MaterialsIndex:
    """可重建的 FTS5 chunk 索引。"""

    def __init__(
        self,
        db_path: Path,
        vault: Path | None = None,
        library_root: Path | None = None,
    ) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # ``vault`` 保留兼容旧调用；原文件定位只依赖当前知识库根目录。
        self._vault = vault if vault is not None else db_path.parents[2]
        self._library_root = library_root or db_path.parent
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=3000")
        self._conn.execute(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    # ------------------------------------------------------------------
    # 写入
    # ------------------------------------------------------------------

    def material_fresh(self, material_id: str, fingerprint: str) -> bool:
        """索引中该 material 的指纹是否与给定值一致（一致则跳过重建）。"""
        rows = self._conn.execute(
            "SELECT sha256 FROM chunks WHERE material_id = ? LIMIT 1",
            (material_id,),
        ).fetchone()
        if rows is None:
            return False
        return rows[0] == fingerprint

    def replace_material(self, material_id: str, chunks: list[dict[str, Any]]) -> None:
        """删除该 material 的旧 chunks 并插入新 chunks（同事务）。"""
        with self._conn:
            self._conn.execute(
                "DELETE FROM chunks WHERE material_id = ?", (material_id,)
            )
            for seq, chunk in enumerate(chunks):
                self._conn.execute(
                    "INSERT INTO chunks (chunk_id, material_id, title, raw_path, kind,"
                    " seg_kind, location, label, sha256, size, mtime_ns, stale_flag,"
                    " seq, content)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        chunk.get("chunkId") or f"{material_id}:{seq}",
                        material_id,
                        chunk["title"],
                        chunk["rawPath"],
                        chunk["kind"],
                        chunk["segKind"],
                        json.dumps(chunk["location"], ensure_ascii=False),
                        chunk["label"],
                        chunk["fingerprint"],
                        chunk["size"],
                        chunk["mtimeNs"],
                        chunk["staleFlag"],
                        seq,
                        chunk["content"],
                    ),
                )

    def remove_except(self, material_ids: set[str]) -> int:
        """删除不在给定集合中的 material chunks，返回删除的 material 数。"""
        rows = self._conn.execute(
            "SELECT DISTINCT material_id FROM chunks"
        ).fetchall()
        removed = 0
        with self._conn:
            for (mid,) in rows:
                if mid not in material_ids:
                    self._conn.execute(
                        "DELETE FROM chunks WHERE material_id = ?", (mid,)
                    )
                    removed += 1
        return removed

    def remove_material(self, material_id: str) -> None:
        """删除单个 material 的全部 chunks（raw/wiki 文件删除后的写入点同步）。"""
        with self._conn:
            self._conn.execute(
                "DELETE FROM chunks WHERE material_id = ?", (material_id,)
            )

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        count: int = 10,
        kinds: tuple[str, ...] = ("source", "derived"),
        vault: Path | None = None,
    ) -> list[dict[str, Any]]:
        """FTS5 检索 chunks，返回结构化结果（含位置与 stale 标记）。"""
        tokens = [t.strip() for t in query.split() if t.strip()]
        if not tokens:
            return []
        long_tokens = [t for t in tokens if len(t) >= _TRIGRAM_MIN]
        short_tokens = [t for t in tokens if len(t) < _TRIGRAM_MIN]

        if long_tokens:
            match = " ".join(f'"{t.replace(chr(34), chr(34) * 2)}"' for t in long_tokens)
            rows = self._conn.execute(
                "SELECT chunk_id, material_id, title, raw_path, kind, seg_kind,"
                " location, label, size, mtime_ns, stale_flag, seq, content,"
                " bm25(chunks) AS rank"
                " FROM chunks WHERE content MATCH ? ORDER BY rank LIMIT 200",
                (match,),
            ).fetchall()
            # ``title`` is intentionally UNINDEXED metadata, so add an exact
            # title candidate pass. Otherwise a paper named by the user's
            # query is invisible when the term does not appear in its body.
            title_conditions = " AND ".join(
                "title LIKE ? ESCAPE '\\'" for _ in long_tokens
            )
            title_params = tuple(
                "%"
                + token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                + "%"
                for token in long_tokens
            )
            title_rows = self._conn.execute(
                "SELECT chunk_id, material_id, title, raw_path, kind, seg_kind,"
                " location, label, size, mtime_ns, stale_flag, seq, content, -1.0"
                f" FROM chunks WHERE {title_conditions} LIMIT 200",
                title_params,
            ).fetchall()
            seen_ids = {row[0] for row in rows}
            rows.extend(row for row in title_rows if row[0] not in seen_ids)
        else:
            # 全部 token 都短于 trigram 下限：子串回退
            rows = self._conn.execute(
                "SELECT chunk_id, material_id, title, raw_path, kind, seg_kind,"
                " location, label, size, mtime_ns, stale_flag, seq, content, 0.0"
                " FROM chunks LIMIT 2000"
            ).fetchall()

        results: list[dict[str, Any]] = []
        for row in rows:
            (chunk_id, material_id, title, raw_path, kind, seg_kind, location_json,
             label, size, mtime_ns, stale_flag, seq, content, rank) = row
            if kind not in kinds:
                continue
            haystack = (title + "\n" + content).lower()
            if any(t.lower() not in haystack for t in short_tokens):
                continue
            if not long_tokens and any(t.lower() not in haystack for t in tokens):
                continue

            score = -float(rank)  # bm25 越小越相关，转为越大越相关
            if kind == "derived":
                score *= _DERIVED_SCORE_FACTOR

            stale = bool(stale_flag)
            if kind == "source" and raw_path:
                stale = not _raw_matches(self._library_root, raw_path, size, mtime_ns)

            result_kind = "material_source" if kind == "source" else "material_wiki"
            results.append({
                "ref": chunk_id,
                "materialId": material_id,
                "kind": result_kind,
                "title": title,
                "rawPath": raw_path,
                "location": json.loads(location_json) if location_json else {},
                "locationLabel": label,
                "snippet": _extract_snippet(content, tokens),
                "score": score,
                "stale": stale,
                "truncated": False,
            })

        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:count]

    def get_chunk(self, ref: str) -> dict[str, Any] | None:
        """按 chunk ref 读取完整内容。"""
        row = self._conn.execute(
            "SELECT chunk_id, material_id, title, raw_path, kind, seg_kind,"
            " location, label, size, mtime_ns, stale_flag, seq, content"
            " FROM chunks WHERE chunk_id = ? LIMIT 1",
            (ref,),
        ).fetchone()
        if row is None:
            return None
        chunk = self._row_to_chunk(row)
        if chunk["kind"] == "material_source" and chunk["rawPath"]:
            chunk["stale"] = not _raw_matches(
                self._library_root,
                chunk["rawPath"],
                chunk["size"],
                chunk["mtimeNs"],
            )
        return chunk

    def get_neighbors(self, ref: str, before: int = 1, after: int = 1) -> list[dict[str, Any]]:
        """返回同一 material 内相邻 seq 的 chunks（上下文扩展）。"""
        chunk = self.get_chunk(ref)
        if chunk is None:
            return []
        material_id = chunk["materialId"]
        seq = chunk["seq"]
        rows = self._conn.execute(
            "SELECT chunk_id, material_id, title, raw_path, kind, seg_kind,"
            " location, label, size, mtime_ns, stale_flag, seq, content"
            " FROM chunks WHERE material_id = ? AND seq >= ? AND seq <= ?"
            " ORDER BY seq",
            (material_id, max(0, seq - before), seq + after),
        ).fetchall()
        return [self._row_to_chunk(r) for r in rows if r[0] != ref]

    @staticmethod
    def _row_to_chunk(row: tuple) -> dict[str, Any]:
        (chunk_id, material_id, title, raw_path, kind, seg_kind, location_json,
         label, size, mtime_ns, stale_flag, seq, content) = row
        return {
            "ref": chunk_id,
            "materialId": material_id,
            "kind": "material_source" if kind == "source" else "material_wiki",
            "title": title,
            "rawPath": raw_path,
            "segKind": seg_kind,
            "location": json.loads(location_json) if location_json else {},
            "locationLabel": label,
            "size": size,
            "mtimeNs": mtime_ns,
            "stale": bool(stale_flag),
            "seq": seq,
            "content": content,
        }


def _raw_matches(library_root: Path, raw_path: str, size: int, mtime_ns: int) -> bool:
    """raw 文件当前 size/mtimeNs 是否与索引记录一致。"""
    raw = library_root / "raw" / raw_path
    try:
        stat = raw.stat()
    except OSError:
        return False
    return stat.st_size == size and stat.st_mtime_ns == mtime_ns


def _parse_text_document(content: str) -> tuple[dict[str, Any], list[tuple[dict[str, Any], str]]]:
    """解析 text/ 文档：frontmatter + seg 标记切分。"""
    fm, body = _parse_frontmatter(content)
    segments: list[tuple[dict[str, Any], str]] = []
    matches = list(_SEG_MARKER_RE.finditer(body))
    for i, m in enumerate(matches):
        try:
            meta = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        text = body[start:end]
        lines = text.split("\n")
        # 去掉紧跟标记的 "## label" 标题行
        if lines and lines[0].strip().startswith("## "):
            lines = lines[1:]
        segments.append((meta, "\n".join(lines).strip()))
    return fm, segments


def _index_text_md(
    vault: Path, index: MaterialsIndex, md_file: Path
) -> tuple[str | None, int | None]:
    """索引单个 text/ 文件。

    返回 (material_id, chunks)：chunks 为 None 表示指纹未变跳过；
    material_id 为 None 表示文件不可索引（读取失败/无 id/状态非 ok），
    调用方不应把它计入存活集合（其旧 chunks 会被 remove_except 清理）。
    """
    del vault  # 路径推导只依赖 md_file 内容与索引
    try:
        content = md_file.read_text(encoding="utf-8")
    except OSError:
        return None, None
    fm, segments = _parse_text_document(content)
    material_id = fm.get("id")
    if not isinstance(material_id, str) or not material_id:
        return None, None
    if fm.get("status") != "ok":
        return None, None
    source = fm.get("source", "")
    if not isinstance(source, str):
        source = ""
    raw_path = source[len("raw/"):] if source.startswith("raw/") else source
    # 指纹基于 text 文件内容本身：重新提取/编辑后必触发重建，
    # frontmatter 中的 raw sha256 仅作为元数据透传。
    fingerprint = hashlib.sha256(content.encode("utf-8")).hexdigest()
    size = _int_or(fm.get("size"), 0)
    mtime_ns = _int_or(fm.get("mtimeNs"), 0)
    if index.material_fresh(material_id, fingerprint):
        return material_id, None
    title = Path(raw_path).name if raw_path else md_file.name
    chunks = []
    for meta, seg_text in segments:
        if not seg_text:
            continue
        location = {
            k: v for k, v in meta.items() if k not in ("kind", "label")
        }
        chunks.append({
            "chunkId": str(meta.get("id") or ""),
            "title": title,
            "rawPath": raw_path,
            "kind": "source",
            "segKind": meta.get("kind", "block"),
            "location": location,
            "label": meta.get("label", ""),
            "fingerprint": fingerprint,
            "size": size,
            "mtimeNs": mtime_ns,
            "staleFlag": 0,
            "content": seg_text,
        })
    index.replace_material(material_id, chunks)
    return material_id, len(chunks)


def _index_wiki_md(
    index: MaterialsIndex, wiki_root: Path, md_file: Path
) -> tuple[str | None, int | None]:
    """索引单个 wiki/ 文件，返回约定同 `_index_text_md`。"""
    try:
        content = md_file.read_text(encoding="utf-8")
    except OSError:
        return None, None
    fm, body = _parse_frontmatter(content)
    wiki_rel = str(md_file.relative_to(wiki_root)).replace("\\", "/")
    material_id = fm.get("id")
    if not isinstance(material_id, str) or not material_id:
        material_id = f"wiki-{wiki_rel}"
    fingerprint = f"mtime:{md_file.stat().st_mtime_ns}"
    if index.material_fresh(material_id, fingerprint):
        return material_id, None
    stale_flag = 1 if str(fm.get("stale", "")).lower() == "true" else 0
    evidence_refs = fm.get("evidenceRefs")
    if not isinstance(evidence_refs, list):
        evidence_refs = []
    evidence_refs = [str(ref) for ref in evidence_refs if str(ref).strip()]
    title = fm.get("title", md_file.stem)
    if not isinstance(title, str):
        title = md_file.stem
    chunks = []
    if body.strip():
        chunks.append({
            "title": title,
            "rawPath": wiki_rel,
            "kind": "derived",
            "segKind": "wiki",
            "location": {"path": wiki_rel, "evidenceRefs": evidence_refs},
            "label": title,
            "fingerprint": fingerprint,
            "size": md_file.stat().st_size,
            "mtimeNs": md_file.stat().st_mtime_ns,
            "staleFlag": stale_flag,
            "content": body.strip(),
        })
    index.replace_material(material_id, chunks)
    return material_id, len(chunks)


def sync_index(
    vault: Path,
    index: MaterialsIndex,
    *,
    library_root: Path | None = None,
) -> dict[str, int]:
    """把 text/ 与 wiki/ 的最新状态增量同步进索引。

    返回 {"indexed": n, "skipped": n, "removed": n}。
    """
    root = library_root or index._library_root
    text_root = root / "text"
    wiki_root = root / "wiki"

    stats = {"indexed": 0, "skipped": 0, "removed": 0}
    seen: set[str] = set()

    if text_root.exists():
        for md_file in sorted(text_root.rglob("*.md")):
            material_id, chunks = _index_text_md(vault, index, md_file)
            if material_id is None:
                continue
            seen.add(material_id)
            if chunks is None:
                stats["skipped"] += 1
            else:
                stats["indexed"] += chunks

    if wiki_root.exists():
        for md_file in sorted(wiki_root.rglob("*.md")):
            material_id, chunks = _index_wiki_md(index, wiki_root, md_file)
            if material_id is None:
                continue
            seen.add(material_id)
            if chunks is None:
                stats["skipped"] += 1
            else:
                stats["indexed"] += chunks

    stats["removed"] = index.remove_except(seen)
    return stats


def sync_write_point(
    vault: Path,
    *,
    library_root: Path | None = None,
    text_files: Iterable[Path] = (),
    wiki_files: Iterable[Path] = (),
    removed_ids: Iterable[str] = (),
    full: bool = False,
) -> None:
    """写入点索引同步：提取/删除/移动/编译/单页写入后调用。

    失败只记日志，绝不影响主流程；reconcile 仍作为兜底全量对账。
    """
    try:
        if library_root is None:
            from mona.materials.catalog import get_library_root

            library_root = get_library_root(vault)
        index = MaterialsIndex(library_root / "index.db", vault=vault, library_root=library_root)
    except Exception:
        logger.exception("materials: open index failed at write point")
        return
    try:
        wiki_root = library_root / "wiki"
        for md_file in text_files:
            try:
                _index_text_md(vault, index, md_file)
            except Exception:
                logger.exception("materials: index sync failed for {}", md_file)
        for md_file in wiki_files:
            try:
                _index_wiki_md(index, wiki_root, md_file)
            except Exception:
                logger.exception("materials: index sync failed for {}", md_file)
        for material_id in removed_ids:
            try:
                index.remove_material(material_id)
            except Exception:
                logger.exception("materials: index remove failed for {}", material_id)
        if full:
            sync_index(vault, index, library_root=library_root)
    finally:
        index.close()


def _int_or(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
