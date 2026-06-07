"""Markdown-aware recursive text chunker for embedding pipelines.

Ported from llm_wiki_tmp/src/lib/text-chunker.ts.

Design constraints:
1. Each chunk carries a heading_path breadcrumb.
2. Split priority: heading sections -> paragraphs -> lines -> sentences -> spaces -> hard slice.
3. Never split inside fenced code blocks or tables.
4. YAML frontmatter is stripped before chunking.
5. Overlap between adjacent chunks within the same section.
6. Tiny chunks (< min_chars) are merged into neighbours.
7. Pure & deterministic: same input => same output.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class ChunkingOptions:
    target_chars: int = 1000
    max_chars: int = 1500
    min_chars: int = 200
    overlap_chars: int = 200


@dataclass
class Chunk:
    index: int
    text: str
    heading_path: str
    char_start: int
    char_end: int
    oversized: bool = False


# -- Public API --


def chunk_markdown(content: str, options: ChunkingOptions | None = None) -> list[Chunk]:
    """Chunk a markdown document into embedding-sized pieces with heading context."""
    opts = options or ChunkingOptions()

    if opts.max_chars < opts.target_chars:
        opts.max_chars = opts.target_chars
    if opts.overlap_chars >= opts.target_chars:
        opts.overlap_chars = opts.target_chars // 2

    body, body_offset = _strip_frontmatter(content)
    if not body.strip():
        return []

    sections = _split_into_sections(body, body_offset)

    chunks: list[Chunk] = []
    running_index = 0
    for section in sections:
        section_chunks = _chunk_section(section, opts)
        for c in section_chunks:
            chunks.append(Chunk(
                index=running_index,
                text=c.text,
                heading_path=c.heading_path,
                char_start=c.char_start,
                char_end=c.char_end,
                oversized=c.oversized,
            ))
            running_index += 1

    return chunks


# -- Frontmatter handling --


def _strip_frontmatter(content: str) -> tuple[str, int]:
    if not content.startswith("---\n") and not content.startswith("---\r\n"):
        return content, 0

    rest = content[4:]
    match = re.search(r"(^|\n)---\s*(\n|$)", rest)
    if match is None:
        return content, 0

    after_match = re.match(r"(\n)?---\s*\n?", rest[match.start():])
    if after_match is None:
        return content, 0

    body_offset = 4 + match.start() + after_match.end()
    return content[body_offset:], body_offset


# -- Section segmentation --


@dataclass
class _Section:
    text: str
    body_start: int
    heading_path: str


def _split_into_sections(body: str, body_offset: int) -> list[_Section]:
    lines = body.split("\n")
    sections: list[_Section] = []
    headings: dict[int, str] = {}

    current_lines: list[str] = []
    current_start = body_offset
    current_heading = ""
    in_fence = False
    fence_marker = ""
    char_cursor = body_offset

    def flush() -> None:
        text = "\n".join(current_lines)
        if text.strip():
            sections.append(_Section(text=text, body_start=current_start, heading_path=current_heading))

    for i, line in enumerate(lines):
        line_len = len(line) + (1 if i < len(lines) - 1 else 0)

        fence_match = re.match(r"^(`{3,}|~{3,})", line)
        if fence_match:
            if not in_fence:
                in_fence = True
                fence_marker = fence_match.group(1)[0] * len(fence_match.group(1))
            elif line.startswith(fence_marker) and line.strip() == fence_marker:
                in_fence = False
            current_lines.append(line)
            char_cursor += line_len
            continue

        h_match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line) if not in_fence else None
        if h_match:
            flush()
            current_lines = []
            level = len(h_match.group(1))
            title = h_match.group(2).strip()
            headings[level] = title
            for lvl in range(level + 1, 7):
                headings.pop(lvl, None)

            path_parts = [f"{'#' * lvl} {headings[lvl]}" for lvl in range(1, 7) if lvl in headings]
            current_heading = " > ".join(path_parts)
            current_start = char_cursor
            char_cursor += line_len
            continue

        current_lines.append(line)
        char_cursor += line_len

    flush()
    return sections


# -- Section -> chunks --


@dataclass
class _RawChunk:
    text: str
    heading_path: str
    char_start: int
    char_end: int
    oversized: bool = False


def _chunk_section(section: _Section, opts: ChunkingOptions) -> list[_RawChunk]:
    text, body_start, heading_path = section.text, section.body_start, section.heading_path

    if len(text) <= opts.target_chars:
        return [_RawChunk(text=text, heading_path=heading_path, char_start=body_start, char_end=body_start + len(text))]

    atoms = _tokenize_atoms(text)
    pieces = _split_atoms_to_pieces(atoms, opts)
    sized = _size_pieces(pieces, opts)
    merged = _merge_small(sized, opts)
    with_overlap = _apply_overlap(merged, opts)

    out: list[_RawChunk] = []
    for piece in with_overlap:
        out.append(_RawChunk(
            text=piece.text,
            heading_path=heading_path,
            char_start=body_start + piece.offset,
            char_end=body_start + piece.offset + len(piece.text),
            oversized=len(piece.text) > opts.max_chars,
        ))
    return out


# -- Atom tokenization --


@dataclass
class _Atom:
    text: str
    offset: int
    indivisible: bool
    kind: str  # "code" | "table" | "paragraph" | "blank"


def _tokenize_atoms(text: str) -> list[_Atom]:
    atoms: list[_Atom] = []
    lines = text.split("\n")
    cursor = 0
    i = 0

    while i < len(lines):
        line = lines[i]

        # Fenced code block
        fence_match = re.match(r"^(`{3,}|~{3,})", line)
        if fence_match:
            marker = fence_match.group(1)
            start = cursor
            body_lines = [line]
            cursor += len(line) + 1
            j = i + 1
            while j < len(lines):
                body_lines.append(lines[j])
                cursor += len(lines[j]) + 1
                if lines[j].startswith(marker) and lines[j].strip() == marker:
                    j += 1
                    break
                j += 1
            atoms.append(_Atom(text="\n".join(body_lines), offset=start, indivisible=True, kind="code"))
            i = j
            continue

        # Table
        if line.startswith("|"):
            j = i
            while j < len(lines) and lines[j].startswith("|"):
                j += 1
            if j - i >= 2:
                start = cursor
                body_lines = lines[i:j]
                content = "\n".join(body_lines)
                cursor += len(content) + (1 if j < len(lines) else 0)
                atoms.append(_Atom(text=content, offset=start, indivisible=True, kind="table"))
                i = j
                continue

        # Blank
        if line.strip() == "":
            atoms.append(_Atom(text="", offset=cursor, indivisible=False, kind="blank"))
            cursor += len(line) + 1
            i += 1
            continue

        # Paragraph
        start = cursor
        body_lines: list[str] = []
        while (
            i < len(lines)
            and lines[i].strip() != ""
            and not lines[i].startswith("|")
            and not re.match(r"^(`{3,}|~{3,})", lines[i])
        ):
            body_lines.append(lines[i])
            cursor += len(lines[i]) + 1
            i += 1
        content = "\n".join(body_lines)
        atoms.append(_Atom(text=content, offset=start, indivisible=False, kind="paragraph"))

    return [a for a in atoms if a.kind != "blank" or a.text]


# -- Splittable atom -> pieces --


@dataclass
class _Piece:
    text: str
    offset: int


def _split_atoms_to_pieces(atoms: list[_Atom], opts: ChunkingOptions) -> list[_Piece]:
    pieces: list[_Piece] = []
    for atom in atoms:
        if atom.indivisible:
            pieces.append(_Piece(text=atom.text, offset=atom.offset))
            continue
        if atom.kind == "blank":
            continue
        if len(atom.text) <= opts.target_chars:
            pieces.append(_Piece(text=atom.text, offset=atom.offset))
            continue
        pieces.extend(_recursive_split(atom.text, atom.offset, opts.target_chars))
    return pieces


def _recursive_split(text: str, base_offset: int, target_chars: int) -> list[_Piece]:
    para_pieces = _split_keeping_sep(text, re.compile(r"(\n{2,})"))
    out: list[_Piece] = []
    cursor = base_offset

    for chunk in para_pieces:
        if not chunk:
            continue
        if len(chunk) <= target_chars:
            out.append(_Piece(text=chunk, offset=cursor))
            cursor += len(chunk)
            continue

        # Try finer separators
        splitters = [
            re.compile(r"(\n+)"),
            re.compile(r"([。！？!?；;]+\s*|(?:\.\s+))"),
            re.compile(r"(\s+)"),
        ]
        found = False
        for sep in splitters:
            subs = _split_keeping_sep(chunk, sep)
            if len(subs) > 1 and all(len(s) <= target_chars for s in subs):
                sub_cursor = cursor
                for s in subs:
                    if s:
                        out.append(_Piece(text=s, offset=sub_cursor))
                        sub_cursor += len(s)
                cursor += len(chunk)
                found = True
                break

        if not found:
            # Hard char slice
            slice_cursor = cursor
            for si in range(0, len(chunk), target_chars):
                piece = chunk[si:si + target_chars]
                out.append(_Piece(text=piece, offset=slice_cursor))
                slice_cursor += len(piece)
            cursor += len(chunk)

    return out


def _split_keeping_sep(text: str, sep: re.Pattern) -> list[str]:
    out: list[str] = []
    last = 0
    for m in sep.finditer(text):
        end = m.end()
        out.append(text[last:end])
        last = end
    if last < len(text):
        out.append(text[last:])
    return [s for s in out if s]


# -- Piece sizing --


def _size_pieces(pieces: list[_Piece], opts: ChunkingOptions) -> list[_Piece]:
    out: list[_Piece] = []
    buf = ""
    buf_offset: int | None = None

    for p in pieces:
        if not p.text:
            continue
        if len(p.text) > opts.target_chars:
            if buf and buf_offset is not None:
                out.append(_Piece(text=buf, offset=buf_offset))
            out.append(_Piece(text=p.text, offset=p.offset))
            buf = ""
            buf_offset = None
            continue
        if buf and len(buf) + len(p.text) > opts.target_chars and buf_offset is not None:
            out.append(_Piece(text=buf, offset=buf_offset))
            buf = p.text
            buf_offset = p.offset
            continue
        if not buf:
            buf_offset = p.offset
        buf += p.text

    if buf and buf_offset is not None:
        out.append(_Piece(text=buf, offset=buf_offset))
    return out


# -- Small-chunk merge --


def _merge_small(pieces: list[_Piece], opts: ChunkingOptions) -> list[_Piece]:
    if len(pieces) < 2:
        return pieces
    out: list[_Piece] = []
    for p in pieces:
        last = out[-1] if out else None
        if last and len(last.text) < opts.min_chars and len(last.text) + len(p.text) <= opts.max_chars:
            out[-1] = _Piece(text=last.text + p.text, offset=last.offset)
        else:
            out.append(p)
    return out


# -- Overlap injection --


def _apply_overlap(pieces: list[_Piece], opts: ChunkingOptions) -> list[_Piece]:
    if opts.overlap_chars <= 0 or len(pieces) < 2:
        return pieces
    out: list[_Piece] = [pieces[0]]
    for i in range(1, len(pieces)):
        prev = pieces[i - 1]
        curr = pieces[i]
        tail_src = prev.text[-opts.overlap_chars:] if len(prev.text) > opts.overlap_chars else prev.text
        snapped = _snap_overlap_head(tail_src)
        out.append(_Piece(text=snapped + curr.text, offset=curr.offset - len(snapped)))
    return out


def _snap_overlap_head(tail: str) -> str:
    sent_match = re.search(r"[。！？!?.;；][\s]*", tail)
    if sent_match:
        after = sent_match.end()
        if 0 < after < len(tail):
            return tail[after:]
    ws_match = re.search(r"\s", tail)
    if ws_match and ws_match.start() < len(tail) - 1:
        return tail[ws_match.start() + 1:]
    return tail
