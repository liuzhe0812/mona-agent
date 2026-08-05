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
from pathlib import Path
from typing import Any

from mona.materials.search import _extract_snippet, _parse_frontmatter

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

    def __init__(self, db_path: Path, vault: Path | None = None) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # vault 默认从 db_path（<vault>/.mona/materials/index.db）推导
        self._vault = vault if vault is not None else db_path.parents[2]
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
                        f"{material_id}:{seq}",
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
                base = vault if vault is not None else self._vault
                stale = not _raw_matches(base, raw_path, size, mtime_ns)

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
        return self._row_to_chunk(row)

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


def _raw_matches(vault: Path, raw_path: str, size: int, mtime_ns: int) -> bool:
    """raw 文件当前 size/mtimeNs 是否与索引记录一致。"""
    raw = vault / ".mona" / "materials" / "raw" / raw_path
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


def sync_index(vault: Path, index: MaterialsIndex) -> dict[str, int]:
    """把 text/ 与 wiki/ 的最新状态增量同步进索引。

    返回 {"indexed": n, "skipped": n, "removed": n}。
    """
    root = vault / ".mona" / "materials"
    text_root = root / "text"
    wiki_root = root / "wiki"

    stats = {"indexed": 0, "skipped": 0, "removed": 0}
    seen: set[str] = set()

    if text_root.exists():
        for md_file in sorted(text_root.rglob("*.md")):
            try:
                content = md_file.read_text(encoding="utf-8")
            except OSError:
                continue
            fm, segments = _parse_text_document(content)
            material_id = fm.get("id")
            if not isinstance(material_id, str) or not material_id:
                continue
            if fm.get("status") != "ok":
                continue
            source = fm.get("source", "")
            raw_path = source[len("raw/"):] if source.startswith("raw/") else source
            # 指纹基于 text 文件内容本身：重新提取/编辑后必触发重建，
            # frontmatter 中的 raw sha256 仅作为元数据透传。
            fingerprint = hashlib.sha256(content.encode("utf-8")).hexdigest()
            size = _int_or(fm.get("size"), 0)
            mtime_ns = _int_or(fm.get("mtimeNs"), 0)
            seen.add(material_id)
            if index.material_fresh(material_id, fingerprint):
                stats["skipped"] += 1
                continue
            title = Path(raw_path).name if raw_path else md_file.name
            chunks = []
            for meta, seg_text in segments:
                if not seg_text:
                    continue
                location = {
                    k: v for k, v in meta.items() if k not in ("kind", "label")
                }
                chunks.append({
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
            stats["indexed"] += len(chunks)

    if wiki_root.exists():
        for md_file in sorted(wiki_root.rglob("*.md")):
            try:
                content = md_file.read_text(encoding="utf-8")
            except OSError:
                continue
            fm, body = _parse_frontmatter(content)
            wiki_rel = str(md_file.relative_to(wiki_root)).replace("\\", "/")
            material_id = fm.get("id") or f"wiki-{wiki_rel}"
            if not isinstance(material_id, str) or not material_id:
                material_id = f"wiki-{wiki_rel}"
            seen.add(material_id)
            fingerprint = f"mtime:{md_file.stat().st_mtime_ns}"
            if index.material_fresh(material_id, fingerprint):
                stats["skipped"] += 1
                continue
            stale_flag = 1 if fm.get("stale") == "true" else 0
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
                    "location": {"path": wiki_rel},
                    "label": title,
                    "fingerprint": fingerprint,
                    "size": md_file.stat().st_size,
                    "mtimeNs": md_file.stat().st_mtime_ns,
                    "staleFlag": stale_flag,
                    "content": body.strip(),
                })
            index.replace_material(material_id, chunks)
            stats["indexed"] += len(chunks)

    stats["removed"] = index.remove_except(seen)
    return stats


def _int_or(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
