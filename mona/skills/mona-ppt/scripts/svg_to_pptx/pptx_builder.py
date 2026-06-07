"""Core PPTX assembly: create_pptx_with_native_svg."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import posixpath
import shutil
import tempfile
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from pptx import Presentation
from pptx.util import Emu

from .drawingml_converter import convert_svg_to_slide_shapes
from .pptx_dimensions import (
    CANVAS_FORMATS,
    get_slide_dimensions, get_pixel_dimensions,
    get_viewbox_dimensions, detect_format_from_svg,
)
from .pptx_media import (
    PNG_RENDERER,
    get_png_renderer_info, convert_svg_to_png, convert_svg_to_png_cached,
)
from .pptx_notes import (
    markdown_to_plain_text,
    create_notes_slide_xml, create_notes_slide_rels_xml,
)
from .pptx_narration import (
    AUDIO_CONTENT_TYPES,
    AUDIO_REL_TYPE,
    IMAGE_REL_TYPE,
    MEDIA_REL_TYPE,
    TRANSPARENT_PNG_BYTES,
    apply_recorded_timing,
    inject_narration,
    next_shape_id,
    probe_audio_duration,
)
from .pptx_slide_xml import (
    ANIMATIONS_AVAILABLE, TRANSITIONS,
    create_slide_xml_with_svg, create_slide_rels_xml,
)

# Re-import create_transition_xml only if available
try:
    from pptx_animations import (
        create_transition_xml,
        create_sequence_timing_xml,
        pick_animation_effect,
    )
except ImportError:
    create_transition_xml = None
    create_sequence_timing_xml = None
    pick_animation_effect = None


CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
SLIDE_REL_TYPE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
)
SLIDE_LAYOUT_REL_TYPE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
)
NOTES_SLIDE_REL_TYPE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
)
SLIDE_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
)

ET.register_namespace("p", PRESENTATION_NS)
ET.register_namespace("a", DRAWING_NS)
ET.register_namespace("r", REL_NS)


def _append_relationship(
    rels_path: Path,
    rel_type: str,
    target: str,
) -> str:
    """Append a relationship entry with the next available rId."""
    with open(rels_path, 'r', encoding='utf-8') as f:
        rels_content = f.read()

    rid_numbers = [int(match) for match in re.findall(r'Id="rId(\d+)"', rels_content)]
    next_rid = f'rId{max(rid_numbers, default=0) + 1}'
    rel_xml = (
        f'  <Relationship Id="{next_rid}" '
        f'Type="{rel_type}" Target="{target}"/>'
    )
    rels_content = rels_content.replace(
        '</Relationships>', rel_xml + '\n</Relationships>',
    )

    with open(rels_path, 'w', encoding='utf-8') as f:
        f.write(rels_content)

    return next_rid


def _relationship_numbers(rels_content: str) -> list[int]:
    return [int(match) for match in re.findall(r'Id="rId(\d+)"', rels_content)]


def _next_relationship_ids(rels_path: Path, count: int) -> list[str]:
    rels_content = rels_path.read_text(encoding='utf-8') if rels_path.exists() else ''
    start = max(_relationship_numbers(rels_content), default=0) + 1
    return [f'rId{start + i}' for i in range(count)]


def _append_relationship_entries(
    rels_path: Path,
    entries: list[tuple[str, str, str]],
) -> None:
    """Append explicit relationship entries to an existing slide .rels file."""
    if rels_path.exists():
        rels_content = rels_path.read_text(encoding='utf-8')
    else:
        rels_path.parent.mkdir(parents=True, exist_ok=True)
        rels_content = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
            '</Relationships>'
        )

    extra = ''.join(
        f'  <Relationship Id="{rid}" Type="{rel_type}" Target="{target}"/>\n'
        for rid, rel_type, target in entries
    )
    rels_content = rels_content.replace('</Relationships>', extra + '</Relationships>')
    rels_path.write_text(rels_content, encoding='utf-8')


def _remap_rel_entries_for_underlay(
    slide_xml: str,
    rel_entries: list[dict[str, str]],
    rels_path: Path,
) -> tuple[str, list[dict[str, str]]]:
    """Move overlay relIds away from template relIds and update slide XML."""
    new_ids = _next_relationship_ids(rels_path, len(rel_entries))
    remapped: list[dict[str, str]] = []
    for rel, new_id in zip(rel_entries, new_ids):
        old_id = rel.get('id', '')
        if old_id:
            slide_xml = slide_xml.replace(f'r:embed="{old_id}"', f'r:embed="{new_id}"')
            slide_xml = slide_xml.replace(f'r:link="{old_id}"', f'r:link="{new_id}"')
            slide_xml = slide_xml.replace(f'r:id="{old_id}"', f'r:id="{new_id}"')
        copied = dict(rel)
        copied['id'] = new_id
        remapped.append(copied)
    return slide_xml, remapped


def _slide_part_name(index: int) -> str:
    return f"ppt/slides/slide{index}.xml"


def _slide_rels_name(index: int) -> str:
    return f"ppt/slides/_rels/slide{index}.xml.rels"


def _read_required(zf: zipfile.ZipFile, name: str) -> bytes:
    try:
        return zf.read(name)
    except KeyError as exc:
        raise ValueError(f"template is missing {name}") from exc


def _max_numeric_rid(relationships_root: ET.Element) -> int:
    max_id = 0
    for rel in relationships_root:
        rid = rel.attrib.get("Id", "")
        match = re.fullmatch(r"rId(\d+)", rid)
        if match:
            max_id = max(max_id, int(match.group(1)))
    return max_id


def _rewrite_underlay_content_types(xml: bytes, slide_count: int) -> bytes:
    root = ET.fromstring(xml)
    override_tag = f"{{{CONTENT_TYPES_NS}}}Override"
    for child in list(root):
        if (
            child.tag == override_tag
            and (
                re.fullmatch(r"/ppt/slides/slide\d+\.xml", child.attrib.get("PartName", ""))
                or re.fullmatch(
                    r"/ppt/notesSlides/notesSlide\d+\.xml",
                    child.attrib.get("PartName", ""),
                )
            )
        ):
            root.remove(child)
    for index in range(1, slide_count + 1):
        ET.SubElement(
            root,
            override_tag,
            {
                "PartName": f"/ppt/slides/slide{index}.xml",
                "ContentType": SLIDE_CONTENT_TYPE,
            },
        )
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _rewrite_underlay_presentation(xml: bytes, slide_rids: list[str]) -> bytes:
    root = ET.fromstring(xml)
    sld_id_lst = root.find(f"{{{PRESENTATION_NS}}}sldIdLst")
    if sld_id_lst is None:
        sld_id_lst = ET.SubElement(root, f"{{{PRESENTATION_NS}}}sldIdLst")
    for child in list(sld_id_lst):
        sld_id_lst.remove(child)
    for index, rid in enumerate(slide_rids, start=1):
        ET.SubElement(
            sld_id_lst,
            f"{{{PRESENTATION_NS}}}sldId",
            {"id": str(255 + index), f"{{{REL_NS}}}id": rid},
        )
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _rewrite_underlay_presentation_rels(xml: bytes, slide_count: int) -> tuple[bytes, list[str]]:
    root = ET.fromstring(xml)
    rel_tag = f"{{{PKG_REL_NS}}}Relationship"
    for child in list(root):
        if child.attrib.get("Type") == SLIDE_REL_TYPE:
            root.remove(child)

    start = _max_numeric_rid(root) + 1
    slide_rids = [f"rId{start + i}" for i in range(slide_count)]
    for index, rid in enumerate(slide_rids, start=1):
        ET.SubElement(
            root,
            rel_tag,
            {
                "Id": rid,
                "Type": SLIDE_REL_TYPE,
                "Target": f"slides/slide{index}.xml",
            },
        )
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), slide_rids


def _strip_template_slide_notes_rels(xml: bytes) -> bytes:
    root = ET.fromstring(xml)
    for child in list(root):
        if child.attrib.get("Type") == NOTES_SLIDE_REL_TYPE:
            root.remove(child)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _create_template_underlay_base_pptx(
    template_pptx: Path,
    slide_count: int,
    output_path: Path,
) -> None:
    """Create a PPTX with template slide 1 repeated for every output slide."""
    if slide_count <= 0:
        raise ValueError("slide_count must be positive")

    with zipfile.ZipFile(template_pptx, "r") as zin:
        names = set(zin.namelist())
        slide_xml = _read_required(zin, _slide_part_name(1))
        slide_rels = (
            _strip_template_slide_notes_rels(zin.read(_slide_rels_name(1)))
            if _slide_rels_name(1) in names
            else (
                b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
                b'</Relationships>'
            )
        )
        presentation_rels_xml, slide_rids = _rewrite_underlay_presentation_rels(
            _read_required(zin, "ppt/_rels/presentation.xml.rels"),
            slide_count,
        )
        presentation_xml = _rewrite_underlay_presentation(
            _read_required(zin, "ppt/presentation.xml"),
            slide_rids,
        )
        content_types_xml = _rewrite_underlay_content_types(
            _read_required(zin, "[Content_Types].xml"),
            slide_count,
        )

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                name = item.filename
                if name == "[Content_Types].xml":
                    zout.writestr(item, content_types_xml)
                elif name == "ppt/presentation.xml":
                    zout.writestr(item, presentation_xml)
                elif name == "ppt/_rels/presentation.xml.rels":
                    zout.writestr(item, presentation_rels_xml)
                elif re.fullmatch(r"ppt/slides/slide\d+\.xml", name):
                    continue
                elif re.fullmatch(r"ppt/slides/_rels/slide\d+\.xml\.rels", name):
                    continue
                elif name.startswith("ppt/notesSlides/"):
                    continue
                else:
                    zout.writestr(item, zin.read(name))

            for index in range(1, slide_count + 1):
                zout.writestr(_slide_part_name(index), slide_xml)
                zout.writestr(_slide_rels_name(index), slide_rels)


def _max_shape_id(root: ET.Element) -> int:
    max_id = 1
    for c_nv_pr in root.iter(f"{{{PRESENTATION_NS}}}cNvPr"):
        raw = c_nv_pr.attrib.get("id")
        if raw and raw.isdigit():
            max_id = max(max_id, int(raw))
    return max_id


def _offset_shape_ids(root: ET.Element, offset: int) -> None:
    for c_nv_pr in root.iter(f"{{{PRESENTATION_NS}}}cNvPr"):
        raw = c_nv_pr.attrib.get("id")
        if raw and raw.isdigit():
            c_nv_pr.attrib["id"] = str(int(raw) + offset)


def _merge_slide_xml_underlay(underlay_xml: str, overlay_xml: str) -> str:
    """Append overlay shapes/timing onto an existing template slide XML."""
    underlay = ET.fromstring(underlay_xml.encode("utf-8"))
    overlay = ET.fromstring(overlay_xml.encode("utf-8"))
    underlay_sp_tree = underlay.find(f".//{{{PRESENTATION_NS}}}spTree")
    overlay_sp_tree = overlay.find(f".//{{{PRESENTATION_NS}}}spTree")
    if underlay_sp_tree is None or overlay_sp_tree is None:
        return overlay_xml

    offset = _max_shape_id(underlay)
    overlay_children = list(overlay_sp_tree)
    for child in overlay_children[2:]:
        _offset_shape_ids(child, offset)
        underlay_sp_tree.append(child)

    for tag_name in ("transition", "timing"):
        tag = f"{{{PRESENTATION_NS}}}{tag_name}"
        for child in list(underlay):
            if child.tag == tag:
                underlay.remove(child)
        overlay_child = overlay.find(tag)
        if overlay_child is not None:
            underlay.append(overlay_child)

    return ET.tostring(underlay, encoding="unicode", xml_declaration=True)


def _add_default_content_type(content_types: str, extension: str, content_type: str) -> str:
    """Add a Default content type if it is not already present."""
    ext = extension.lstrip(".")
    if f'Extension="{ext}"' in content_types:
        return content_types
    entry = f'  <Default Extension="{ext}" ContentType="{content_type}"/>'
    return content_types.replace('</Types>', entry + '\n</Types>')


_IMAGE_CONTENT_TYPES = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'bmp': 'image/bmp',
    'emf': 'image/x-emf',
    'tif': 'image/tiff',
    'tiff': 'image/tiff',
    'wmf': 'image/x-wmf',
}


def _content_type_for_extension(ext: str) -> str:
    clean = ext.lower().lstrip('.')
    content_type = _IMAGE_CONTENT_TYPES.get(clean) or mimetypes.guess_type(f'x.{clean}')[0]
    if not content_type:
        raise ValueError(f"Unknown media content type for extension: {ext}")
    return content_type


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _to_float(value: Any, default: float) -> float:
    if value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if number >= 0 else default


def _slide_config(animation_config: dict[str, Any] | None, svg_stem: str) -> dict[str, Any]:
    if not animation_config:
        return {}
    slides = _as_dict(animation_config.get('slides'))
    return _as_dict(slides.get(svg_stem))


def _slide_transition_settings(
    slide_cfg: dict[str, Any],
    transition: str | None,
    duration: float,
    auto_advance: float | None,
    cli_overrides: dict[str, bool],
) -> tuple[str | None, float, float | None]:
    trans_cfg = _as_dict(slide_cfg.get('transition'))
    effect = transition
    if not cli_overrides.get('transition') and 'effect' in trans_cfg:
        cfg_effect = str(trans_cfg.get('effect'))
        effect = None if cfg_effect == 'none' else cfg_effect
    if not cli_overrides.get('transition_duration'):
        duration = _to_float(trans_cfg.get('duration'), duration)
    if not cli_overrides.get('auto_advance') and 'auto_advance' in trans_cfg:
        auto_advance = _to_float(trans_cfg.get('auto_advance'), auto_advance or 0)
    return effect, duration, auto_advance


def _slide_animation_settings(
    slide_cfg: dict[str, Any],
    animation: str | None,
    duration: float,
    stagger: float,
    trigger: str,
    cli_overrides: dict[str, bool],
) -> tuple[str | None, float, float, str]:
    anim_cfg = _as_dict(slide_cfg.get('animation'))
    effect = animation
    if not cli_overrides.get('animation') and 'effect' in anim_cfg:
        cfg_effect = str(anim_cfg.get('effect'))
        effect = None if cfg_effect == 'none' else cfg_effect
    if not cli_overrides.get('animation_duration'):
        duration = _to_float(anim_cfg.get('duration'), duration)
    if not cli_overrides.get('animation_stagger'):
        stagger = _to_float(anim_cfg.get('stagger'), stagger)
    if not cli_overrides.get('animation_trigger') and anim_cfg.get('trigger'):
        trigger = str(anim_cfg.get('trigger'))
    return effect, duration, stagger, trigger


def _build_sequence_targets(
    anim_targets: list[tuple[int, str]],
    slide_cfg: dict[str, Any],
    animation: str,
    duration: float,
    stagger: float,
    mixed_animation_offset: int,
) -> tuple[list[tuple[int, int, str, float]], int]:
    groups_cfg = _as_dict(slide_cfg.get('groups'))
    ordered: list[tuple[int, int, int, str, dict[str, Any]]] = []
    for idx, (sid, svg_id) in enumerate(anim_targets):
        group_cfg = _as_dict(groups_cfg.get(svg_id))
        if str(group_cfg.get('effect', '')).lower() == 'none':
            continue
        order_value = group_cfg.get('order')
        try:
            order = int(order_value)
            has_order = 0
        except (TypeError, ValueError):
            order = idx
            has_order = 1
        group_entry = dict(group_cfg)
        group_entry['_shape_id'] = sid
        ordered.append((has_order, order, idx, svg_id, group_entry))

    ordered.sort(key=lambda item: (item[0], item[1], item[2]))

    seq_targets: list[tuple[int, int, str, float]] = []
    for seq_idx, (_has_order, _order, _original_idx, _svg_id, group_cfg) in enumerate(ordered):
        shape_id = int(group_cfg['_shape_id'])
        raw_effect = group_cfg.get('effect')
        if raw_effect in ('auto', 'mixed', 'random'):
            effect = pick_animation_effect(
                str(raw_effect), seq_idx, mixed_animation_offset, group_id=_svg_id,
            )
        else:
            effect = str(raw_effect or pick_animation_effect(
                animation, seq_idx, mixed_animation_offset, group_id=_svg_id,
            ))
        item_duration = _to_float(group_cfg.get('duration'), duration)
        delay_seconds = _to_float(
            group_cfg.get('delay'),
            0 if seq_idx == 0 else stagger,
        )
        seq_targets.append((shape_id, int(delay_seconds * 1000), effect, item_duration))

    mixed_count = 0
    if animation == 'mixed':
        mixed_count = sum(1 for _target in seq_targets[1:])
    elif animation == 'auto':
        # 'auto' accumulates a cross-slide offset so the image pool and the
        # unmatched-id fallback rotate as the deck advances. Single-effect
        # semantic matches (title→fade, chart→wipe etc.) are unaffected
        # because they ignore the offset.
        mixed_count = len(seq_targets)
    return seq_targets, mixed_count


def _prerender_legacy_pngs(
    svg_files: list[Path],
    media_dir: Path,
    pixel_width: int,
    pixel_height: int,
    cache_dir: Path | None,
    workers: int,
    verbose: bool,
) -> dict[int, bool]:
    """Render every SVG→PNG into media_dir in parallel.

    Returns {1-based slide index: success}. Falls back to sequential when
    workers<=1 or len(svg_files)<=2.
    """
    results: dict[int, bool] = {}
    targets: list[tuple[int, Path, Path]] = [
        (i, svg, media_dir / f'image{i}.png')
        for i, svg in enumerate(svg_files, 1)
    ]

    if workers <= 1 or len(targets) <= 2:
        for i, svg, png in targets:
            ok = convert_svg_to_png_cached(svg, png, pixel_width, pixel_height, cache_dir)
            results[i] = ok
            if verbose:
                tag = 'cached/ok' if ok else 'failed'
                print(f"  [PNG {i}/{len(targets)}] {svg.name} - {tag}")
        return results

    with ProcessPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(
                convert_svg_to_png_cached,
                svg, png, pixel_width, pixel_height, cache_dir,
            ): (i, svg)
            for i, svg, png in targets
        }
        done = 0
        for future in as_completed(future_map):
            i, svg = future_map[future]
            try:
                ok = future.result()
            except Exception as exc:
                ok = False
                if verbose:
                    print(f"  [PNG] {svg.name} - worker error: {exc}")
            results[i] = ok
            done += 1
            if verbose:
                tag = 'cached/ok' if ok else 'failed'
                print(f"  [PNG {done}/{len(targets)}] {svg.name} - {tag}")

    return results


_REL_TARGET_RE = re.compile(r'<Relationship\b[^/]*?/>', re.DOTALL)
_TARGET_ATTR_RE = re.compile(r'Target="([^"]+)"')
_TARGET_MODE_EXT_RE = re.compile(r'TargetMode="External"')


def _verify_internal_rels_targets(extract_dir: Path) -> list[str]:
    """Return a list of dangling internal Targets across every .rels in the package.

    Each entry is formatted as "<rels-path> -> <missing-target>". An empty list
    means every internal Target resolves to a real file in the package.
    """
    problems: list[str] = []
    for rels_path in extract_dir.rglob('*.rels'):
        rels_rel = rels_path.relative_to(extract_dir).as_posix()
        # `_rels/foo.xml.rels` lives one level below its referent's directory;
        # Targets resolve relative to the parent of that `_rels` folder.
        base_dir = posixpath.dirname(posixpath.dirname(rels_rel))
        content = rels_path.read_text(encoding='utf-8')
        for match in _REL_TARGET_RE.finditer(content):
            element = match.group(0)
            if _TARGET_MODE_EXT_RE.search(element):
                continue
            target_match = _TARGET_ATTR_RE.search(element)
            if not target_match:
                continue
            target = target_match.group(1)
            if target.startswith(('http://', 'https://', 'mailto:')):
                continue
            resolved = posixpath.normpath(posixpath.join(base_dir, target)) if base_dir else posixpath.normpath(target)
            if not (extract_dir / resolved).exists():
                problems.append(f'{rels_rel} -> {resolved}')
    return problems


def create_pptx_with_native_svg(
    svg_files: list[Path],
    output_path: Path,
    canvas_format: str | None = None,
    verbose: bool = True,
    transition: str | None = 'fade',
    transition_duration: float = 0.5,
    auto_advance: float | None = None,
    use_compat_mode: bool = True,
    notes: dict[str, str] | None = None,
    enable_notes: bool = True,
    use_native_shapes: bool = False,
    animation: str | None = None,
    animation_duration: float = 0.4,
    animation_stagger: float = 0.5,
    animation_trigger: str = 'after-previous',
    animation_config: dict[str, Any] | None = None,
    animation_cli_overrides: dict[str, bool] | None = None,
    narration_audio: dict[str, Path] | None = None,
    use_narration_timings: bool = False,
    narration_padding: float = 0.5,
    cache_dir: Path | None = None,
    workers: int | None = None,
    merge_paragraphs: bool = False,
    conversion_trace_path: Path | None = None,
    template_pptx: Path | None = None,
    template_underlay_pptx: Path | None = None,
) -> bool:
    """Create a PPTX file with native SVG.

    Args:
        svg_files: List of SVG files.
        output_path: Output PPTX path.
        canvas_format: Canvas format key.
        verbose: Whether to output detailed information.
        transition: Transition effect name.
        transition_duration: Transition duration in seconds.
        auto_advance: Auto-advance interval in seconds.
        use_compat_mode: Use Office compatibility mode (PNG + SVG dual format).
        notes: Notes dict, key is SVG stem, value is notes content.
        enable_notes: Whether to enable notes embedding.
        use_native_shapes: Convert SVG to native DrawingML shapes.
        animation: Per-element entrance animation mode (single effect name,
            'mixed', 'random', or None to disable). Native shapes mode only.
        animation_duration: Per-element entrance duration in seconds.
        animation_stagger: Delay between elements in ``after-previous``
            trigger mode (seconds). Ignored otherwise.
        animation_trigger: PowerPoint Start mode — ``'after-previous'`` (default),
            ``'on-click'``, or ``'with-previous'``.
        animation_config: Optional sidecar overrides loaded from animations.json.
        animation_cli_overrides: Flags indicating explicit CLI overrides.
        narration_audio: Optional dict mapping SVG stem to narration audio file.
        use_narration_timings: Whether to set slide auto-advance from audio duration.
        narration_padding: Extra seconds added after each narration before advancing.
        conversion_trace_path: Optional JSON path for native conversion diagnostics.

    Returns:
        Whether all slides were successfully created.
    """
    if not svg_files:
        print("Error: No SVG files found")
        return False

    # Native shapes mode takes priority over compat mode
    if use_native_shapes:
        use_compat_mode = False

    # Check compatibility mode dependencies
    renderer_name, renderer_status, renderer_hint = get_png_renderer_info()
    if not use_native_shapes and use_compat_mode and PNG_RENDERER is None:
        print("Warning: No PNG rendering library installed, cannot use compatibility mode")
        print(f"  {renderer_hint}")
        print("  Will use pure SVG mode (may not display in Office LTSC 2021 and similar versions)")
        use_compat_mode = False

    # Auto-detect canvas format or get dimensions from viewBox
    custom_pixels: tuple[int, int] | None = None
    if canvas_format is None:
        canvas_format = detect_format_from_svg(svg_files[0])
        if canvas_format and verbose:
            format_name = CANVAS_FORMATS.get(canvas_format, {}).get('name', canvas_format)
            print(f"  Detected canvas format: {format_name}")

    if canvas_format is None:
        custom_pixels = get_viewbox_dimensions(svg_files[0])
        if custom_pixels and verbose:
            print(f"  Using SVG viewBox dimensions: {custom_pixels[0]} x {custom_pixels[1]} px")

    if canvas_format is None and custom_pixels is None:
        canvas_format = 'ppt169'
        if verbose:
            print(f"  Using default format: PPT 16:9")

    width_emu, height_emu = get_slide_dimensions(canvas_format or 'ppt169', custom_pixels)
    if template_underlay_pptx and template_underlay_pptx.exists():
        template_prs = Presentation(str(template_underlay_pptx))
        width_emu = template_prs.slide_width
        height_emu = template_prs.slide_height
    pixel_width, pixel_height = get_pixel_dimensions(canvas_format or 'ppt169', custom_pixels)

    if verbose:
        print(f"  Slide dimensions: {pixel_width} x {pixel_height} px")
        print(f"  SVG file count: {len(svg_files)}")
        if use_native_shapes:
            print(f"  Mode: Native DrawingML shapes (directly editable)")
        elif use_compat_mode:
            print(f"  Compatibility mode: Enabled (PNG + SVG dual format)")
            print(f"  PNG renderer: {renderer_name} {renderer_status}")
        else:
            print(f"  Compatibility mode: Disabled (pure SVG)")
        if transition:
            trans_name = TRANSITIONS.get(transition, {}).get('name', transition) if TRANSITIONS else transition
            print(f"  Transition effect: {trans_name}")
        if enable_notes and notes:
            print(f"  Speaker notes: {len(notes)} page(s)")
        elif enable_notes:
            print(f"  Speaker notes: Enabled (no notes files found)")
        else:
            print(f"  Speaker notes: Disabled")
        if template_underlay_pptx and template_underlay_pptx.exists():
            print(f"  Template underlay: {template_underlay_pptx}")
        print()

    animation_cli_overrides = animation_cli_overrides or {}

    temp_dir = Path(tempfile.mkdtemp())

    try:
        # Create base PPTX with python-pptx, or repeat template slide 1 as an underlay.
        base_pptx = temp_dir / 'base.pptx'
        use_template_underlay = bool(template_underlay_pptx and template_underlay_pptx.exists())
        if use_template_underlay:
            _create_template_underlay_base_pptx(
                template_underlay_pptx,
                len(svg_files),
                base_pptx,
            )
        elif template_pptx and template_pptx.exists():
            prs = Presentation(str(template_pptx))
            # Override canvas dimensions from template
            width_emu = prs.slide_width
            height_emu = prs.slide_height
            # Remove all existing slides from template (keep masters/layouts)
            while len(prs.slides) > 0:
                rid = prs.slides._sldIdLst[0].get(
                    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
                )
                prs.part.drop_rel(rid)
                prs.slides._sldIdLst.remove(prs.slides._sldIdLst[0])

            blank_layout = prs.slide_layouts[6]
            for _ in svg_files:
                prs.slides.add_slide(blank_layout)

            prs.save(str(base_pptx))
        else:
            prs = Presentation()
            prs.slide_width = width_emu
            prs.slide_height = height_emu

            blank_layout = prs.slide_layouts[6]
            for _ in svg_files:
                prs.slides.add_slide(blank_layout)

            prs.save(str(base_pptx))

        # Extract PPTX
        extract_dir = temp_dir / 'pptx_content'
        with zipfile.ZipFile(base_pptx, 'r') as zf:
            zf.extractall(extract_dir)

        media_dir = extract_dir / 'ppt' / 'media'
        media_dir.mkdir(exist_ok=True)

        prerender_results: dict[int, bool] | None = None
        if not use_native_shapes and use_compat_mode and PNG_RENDERER is not None:
            if workers is None:
                resolved_workers = min(os.cpu_count() or 2, len(svg_files), 8)
            else:
                resolved_workers = max(0, workers)
            if verbose:
                cache_label = str(cache_dir) if cache_dir else 'disabled'
                mode = f'parallel x{resolved_workers}' if resolved_workers > 1 else 'sequential'
                print(f"  Pre-rendering PNGs ({mode}, cache: {cache_label})")
            prerender_results = _prerender_legacy_pngs(
                svg_files, media_dir, pixel_width, pixel_height,
                cache_dir, resolved_workers, verbose,
            )
            if verbose:
                print()

        success_count = 0
        has_any_image = False
        media_cache: dict[tuple[str, str], str] = {}
        image_exts_used: set[str] = set()
        notes_slides_created: set[int] = set()
        narration_slides_created: set[int] = set()
        audio_exts_used: set[str] = set()
        mixed_animation_offset = 0
        conversion_trace: list[dict[str, Any]] | None = [] if conversion_trace_path else None

        for i, svg_path in enumerate(svg_files, 1):
            slide_num = i

            try:
                # ---- Native shapes mode ----
                if use_native_shapes:
                    slide_cfg = _slide_config(animation_config, svg_path.stem)
                    slide_xml, media_files_dict, rel_entries, anim_targets = (
                        convert_svg_to_slide_shapes(
                            svg_path, slide_num=slide_num, verbose=verbose,
                            merge_paragraphs=merge_paragraphs,
                            trace_out=conversion_trace,
                        )
                    )
                    slide_transition, slide_transition_duration, slide_auto_advance = (
                        _slide_transition_settings(
                            slide_cfg,
                            transition,
                            transition_duration,
                            auto_advance,
                            animation_cli_overrides,
                        )
                    )
                    (
                        slide_animation,
                        slide_animation_duration,
                        slide_animation_stagger,
                        slide_animation_trigger,
                    ) = _slide_animation_settings(
                        slide_cfg,
                        animation,
                        animation_duration,
                        animation_stagger,
                        animation_trigger,
                        animation_cli_overrides,
                    )

                    # Order matters: OOXML schema requires <p:transition>
                    # to precede <p:timing> inside <p:sld>. Both use the same
                    # </p:sld> string-replace anchor, so transition must be
                    # injected first and timing second.
                    if slide_transition and ANIMATIONS_AVAILABLE and create_transition_xml:
                        transition_xml = '\n' + create_transition_xml(
                            effect=slide_transition,
                            duration=slide_transition_duration,
                            advance_after=slide_auto_advance,
                        )
                        slide_xml = slide_xml.replace(
                            '</p:sld>',
                            transition_xml + '\n</p:sld>',
                        )

                    if (slide_animation and slide_animation != 'none'
                            and create_sequence_timing_xml
                            and pick_animation_effect
                            and anim_targets):
                        seq_targets, mixed_count = _build_sequence_targets(
                            anim_targets,
                            slide_cfg,
                            slide_animation,
                            slide_animation_duration,
                            slide_animation_stagger,
                            mixed_animation_offset,
                        )
                        if slide_animation in ('mixed', 'auto'):
                            mixed_animation_offset += mixed_count
                        timing_xml = '\n' + create_sequence_timing_xml(
                            seq_targets, duration=slide_animation_duration,
                            trigger=slide_animation_trigger,
                        )
                        slide_xml = slide_xml.replace(
                            '</p:sld>',
                            timing_xml + '\n</p:sld>',
                        )

                    slide_xml_path = extract_dir / 'ppt' / 'slides' / f'slide{slide_num}.xml'

                    # Write media files
                    media_name_map: dict[str, str] = {}
                    for media_name, media_data in media_files_dict.items():
                        ext = media_name.rsplit('.', 1)[-1].lower()
                        media_hash = hashlib.sha256(media_data).hexdigest()
                        cache_key = (ext, media_hash)
                        cached_name = media_cache.get(cache_key)

                        if cached_name is None:
                            cached_name = f'image_{media_hash[:16]}.{ext}'
                            media_cache[cache_key] = cached_name
                            with open(media_dir / cached_name, 'wb') as f:
                                f.write(media_data)

                        media_name_map[media_name] = cached_name

                    for rel in rel_entries:
                        target = rel.get('target', '')
                        if not target.startswith('../media/'):
                            continue
                        media_name = target.split('../media/', 1)[1]
                        mapped_name = media_name_map.get(media_name)
                        if mapped_name:
                            rel['target'] = f'../media/{mapped_name}'

                    # Build relationships XML
                    rels_dir = extract_dir / 'ppt' / 'slides' / '_rels'
                    rels_dir.mkdir(exist_ok=True)
                    rels_path = rels_dir / f'slide{slide_num}.xml.rels'

                    if use_template_underlay:
                        underlay_slide_xml = slide_xml_path.read_text(encoding='utf-8')
                        slide_xml, rel_entries = _remap_rel_entries_for_underlay(
                            slide_xml,
                            rel_entries,
                            rels_path,
                        )
                        rel_tuples = [
                            (rel["id"], rel["type"], rel["target"])
                            for rel in rel_entries
                        ]
                        _append_relationship_entries(rels_path, rel_tuples)
                        slide_xml = _merge_slide_xml_underlay(underlay_slide_xml, slide_xml)
                    else:
                        extra_rels = ''
                        for rel in rel_entries:
                            extra_rels += (
                                f'\n  <Relationship Id="{rel["id"]}" '
                                f'Type="{rel["type"]}" Target="{rel["target"]}"/>'
                            )

                        rels_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>{extra_rels}
</Relationships>'''
                        with open(rels_path, 'w', encoding='utf-8') as f:
                            f.write(rels_xml)

                    with open(slide_xml_path, 'w', encoding='utf-8') as f:
                        f.write(slide_xml)

                    # Track image formats for Content_Types
                    for media_name in media_name_map.values():
                        ext = media_name.rsplit('.', 1)[-1].lower()
                        _content_type_for_extension(ext)
                        image_exts_used.add(ext)
                        has_any_image = True

                # ---- Legacy SVG embedding mode ----
                else:
                    slide_cfg = _slide_config(animation_config, svg_path.stem)
                    slide_transition, slide_transition_duration, slide_auto_advance = (
                        _slide_transition_settings(
                            slide_cfg,
                            transition,
                            transition_duration,
                            auto_advance,
                            animation_cli_overrides,
                        )
                    )
                    svg_filename = f'image{i}.svg'
                    png_filename = f'image{i}.png'
                    rels_dir = extract_dir / 'ppt' / 'slides' / '_rels'
                    rels_dir.mkdir(exist_ok=True)
                    rels_path = rels_dir / f'slide{slide_num}.xml.rels'
                    if use_template_underlay:
                        rid_count = 2 if use_compat_mode else 1
                        new_rids = _next_relationship_ids(rels_path, rid_count)
                        png_rid = new_rids[0]
                        svg_rid = new_rids[1] if use_compat_mode else new_rids[0]
                    else:
                        png_rid = 'rId2'
                        svg_rid = 'rId3' if use_compat_mode else 'rId2'

                    shutil.copy(svg_path, media_dir / svg_filename)

                    slide_has_png = False
                    if use_compat_mode:
                        if prerender_results is not None:
                            png_success = prerender_results.get(i, False)
                        else:
                            png_path = media_dir / png_filename
                            png_success = convert_svg_to_png(
                                svg_path, png_path,
                                width=pixel_width, height=pixel_height,
                            )
                        if png_success:
                            slide_has_png = True
                            has_any_image = True
                            image_exts_used.add('png')
                        else:
                            if verbose:
                                print(f"  [{i}/{len(svg_files)}] {svg_path.name} - PNG generation failed, using pure SVG")
                            svg_rid = 'rId2'

                    slide_xml_path = extract_dir / 'ppt' / 'slides' / f'slide{slide_num}.xml'
                    slide_xml = create_slide_xml_with_svg(
                        slide_num,
                        png_rid=png_rid, svg_rid=svg_rid,
                        width_emu=width_emu, height_emu=height_emu,
                        transition=slide_transition,
                        transition_duration=slide_transition_duration,
                        auto_advance=slide_auto_advance,
                        use_compat_mode=(use_compat_mode and slide_has_png),
                    )
                    if use_template_underlay:
                        underlay_slide_xml = slide_xml_path.read_text(encoding='utf-8')
                        rel_entries_to_add = []
                        if use_compat_mode and slide_has_png:
                            rel_entries_to_add.append((png_rid, IMAGE_REL_TYPE, f'../media/{png_filename}'))
                            rel_entries_to_add.append((svg_rid, IMAGE_REL_TYPE, f'../media/{svg_filename}'))
                        else:
                            rel_entries_to_add.append((svg_rid, IMAGE_REL_TYPE, f'../media/{svg_filename}'))
                        _append_relationship_entries(rels_path, rel_entries_to_add)
                        slide_xml = _merge_slide_xml_underlay(underlay_slide_xml, slide_xml)
                        with open(slide_xml_path, 'w', encoding='utf-8') as f:
                            f.write(slide_xml)
                    else:
                        with open(slide_xml_path, 'w', encoding='utf-8') as f:
                            f.write(slide_xml)

                        rels_xml = create_slide_rels_xml(
                            png_rid=png_rid, png_filename=png_filename,
                            svg_rid=svg_rid, svg_filename=svg_filename,
                            use_compat_mode=(use_compat_mode and slide_has_png),
                        )
                        with open(rels_path, 'w', encoding='utf-8') as f:
                            f.write(rels_xml)

                # --- Process notes (shared between native and legacy mode) ---
                notes_content = ''
                if enable_notes:
                    svg_stem = svg_path.stem
                    notes_content = notes.get(svg_stem, '') if notes else ''
                    notes_text = markdown_to_plain_text(notes_content) if notes_content else ''
                    if notes_text:
                        notes_slides_dir = extract_dir / 'ppt' / 'notesSlides'
                        notes_slides_dir.mkdir(exist_ok=True)

                        notes_xml_path = notes_slides_dir / f'notesSlide{slide_num}.xml'
                        notes_xml = create_notes_slide_xml(slide_num, notes_text)
                        with open(notes_xml_path, 'w', encoding='utf-8') as f:
                            f.write(notes_xml)

                        notes_rels_dir = notes_slides_dir / '_rels'
                        notes_rels_dir.mkdir(exist_ok=True)
                        notes_rels_path = notes_rels_dir / f'notesSlide{slide_num}.xml.rels'
                        notes_rels_xml = create_notes_slide_rels_xml(slide_num)
                        with open(notes_rels_path, 'w', encoding='utf-8') as f:
                            f.write(notes_rels_xml)

                        _append_relationship(
                            rels_path,
                            'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
                            f'../notesSlides/notesSlide{slide_num}.xml',
                        )
                        notes_slides_created.add(slide_num)

                # --- Process narration audio (shared between native and legacy mode) ---
                svg_stem = svg_path.stem
                audio_path = narration_audio.get(svg_stem) if narration_audio else None
                if audio_path:
                    slide_xml_path = extract_dir / 'ppt' / 'slides' / f'slide{slide_num}.xml'
                    rels_path = extract_dir / 'ppt' / 'slides' / '_rels' / f'slide{slide_num}.xml.rels'

                    ext = audio_path.suffix.lower()
                    media_name = f'narration{slide_num}{ext}'
                    shutil.copy2(audio_path, media_dir / media_name)
                    audio_exts_used.add(ext)

                    poster_name = 'narration_poster.png'
                    poster_path = media_dir / poster_name
                    if not poster_path.exists():
                        poster_path.write_bytes(TRANSPARENT_PNG_BYTES)
                    has_any_image = True
                    image_exts_used.add('png')

                    media_rid = _append_relationship(
                        rels_path,
                        MEDIA_REL_TYPE,
                        f'../media/{media_name}',
                    )
                    audio_rid = _append_relationship(
                        rels_path,
                        AUDIO_REL_TYPE,
                        f'../media/{media_name}',
                    )
                    poster_rid = _append_relationship(
                        rels_path,
                        IMAGE_REL_TYPE,
                        f'../media/{poster_name}',
                    )

                    slide_xml = slide_xml_path.read_text(encoding='utf-8')
                    narration_shape_id = next_shape_id(slide_xml)
                    slide_xml = inject_narration(
                        slide_xml,
                        shape_id=narration_shape_id,
                        shape_name=media_name,
                        audio_rid=audio_rid,
                        media_rid=media_rid,
                        poster_rid=poster_rid,
                    )

                    if use_narration_timings:
                        duration = probe_audio_duration(audio_path)
                        if duration is None:
                            raise RuntimeError(
                                f"Unable to read narration duration with ffprobe: {audio_path}"
                            )
                        slide_xml = apply_recorded_timing(
                            slide_xml,
                            advance_after=duration + narration_padding,
                            transition_duration=slide_transition_duration,
                            transition_effect=slide_transition or 'fade',
                        )
                    slide_xml_path.write_text(slide_xml, encoding='utf-8')
                    narration_slides_created.add(slide_num)

                if verbose:
                    if use_native_shapes:
                        mode_str = " (Native)"
                    elif use_compat_mode and not use_native_shapes:
                        mode_str = " (PNG+SVG)" if has_any_image else " (SVG)"
                    else:
                        mode_str = " (SVG)"
                    has_notes = slide_num in notes_slides_created
                    notes_str = " +notes" if has_notes else ""
                    narration_str = " +narration" if slide_num in narration_slides_created else ""
                    print(f"  [{i}/{len(svg_files)}] {svg_path.name}{mode_str}{notes_str}{narration_str}")

                success_count += 1

            except Exception as e:
                if verbose:
                    print(f"  [{i}/{len(svg_files)}] {svg_path.name} - Error: {e}")
                if use_native_shapes:
                    raise

        # Update [Content_Types].xml
        content_types_path = extract_dir / '[Content_Types].xml'
        with open(content_types_path, 'r', encoding='utf-8') as f:
            content_types = f.read()

        types_to_add: list[str] = []
        if not use_native_shapes:
            if 'Extension="svg"' not in content_types:
                types_to_add.append('  <Default Extension="svg" ContentType="image/svg+xml"/>')
        for ext in sorted(image_exts_used):
            if f'Extension="{ext}"' not in content_types:
                types_to_add.append(
                    f'  <Default Extension="{ext}" ContentType="{_content_type_for_extension(ext)}"/>'
                )

        if types_to_add:
            content_types = content_types.replace(
                '</Types>', '\n'.join(types_to_add) + '\n</Types>',
            )
            with open(content_types_path, 'w', encoding='utf-8') as f:
                f.write(content_types)

        if audio_exts_used:
            for ext in sorted(audio_exts_used):
                content_type = AUDIO_CONTENT_TYPES.get(ext)
                if content_type:
                    content_types = _add_default_content_type(content_types, ext, content_type)
            if 'Extension="png"' not in content_types:
                content_types = _add_default_content_type(content_types, 'png', 'image/png')
            with open(content_types_path, 'w', encoding='utf-8') as f:
                f.write(content_types)

        # Add notesSlides content types
        if enable_notes and notes_slides_created:
            for i in sorted(notes_slides_created):
                override = (
                    f'  <Override PartName="/ppt/notesSlides/notesSlide{i}.xml" '
                    f'ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>'
                )
                if override not in content_types:
                    content_types = content_types.replace('</Types>', override + '\n</Types>')
            with open(content_types_path, 'w', encoding='utf-8') as f:
                f.write(content_types)

        rels_problems = _verify_internal_rels_targets(extract_dir)
        if rels_problems:
            details = '\n'.join(f'  - {p}' for p in rels_problems)
            raise RuntimeError(
                'PPTX package contains dangling internal relationship targets; '
                'PowerPoint will report the file as corrupt:\n' + details
            )

        # Repackage PPTX to a temporary file first. The public output path is
        # replaced only after every slide and relationship has succeeded.
        temp_output_path = temp_dir / 'result.pptx'
        with zipfile.ZipFile(temp_output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_path in extract_dir.rglob('*'):
                if file_path.is_file():
                    arcname = file_path.relative_to(extract_dir)
                    zf.write(file_path, arcname)
        shutil.move(str(temp_output_path), str(output_path))

        if conversion_trace_path and conversion_trace is not None:
            conversion_trace_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                'output': str(output_path),
                'slide_count': len(svg_files),
                'slides': conversion_trace,
            }
            conversion_trace_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding='utf-8',
            )

        if verbose:
            print()
            print(f"[Done] Saved: {output_path}")
            if conversion_trace_path and conversion_trace is not None:
                print(f"  Trace: {conversion_trace_path}")
            print(f"  Succeeded: {success_count}, Failed: {len(svg_files) - success_count}")
            if use_compat_mode and has_any_image:
                print(f"  Mode: Office compatibility mode (supports all Office versions)")
                if PNG_RENDERER == 'svglib' and renderer_hint:
                    print(f"  [Tip] {renderer_hint}")

        return success_count == len(svg_files)

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
