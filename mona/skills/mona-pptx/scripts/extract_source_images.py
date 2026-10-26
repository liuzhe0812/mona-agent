"""Export document pictures, or a PDF page region, into new workspace assets."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import posixpath
import re
import sys
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring
from PIL import Image

REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024
FORMATS = {"PNG": "png", "JPEG": "jpg", "GIF": "gif", "BMP": "bmp", "WEBP": "webp"}


def workspace_root() -> Path:
    root = Path(os.environ.get("MONA_ACTIVE_WORKSPACE") or Path.cwd()).resolve()
    if not root.is_dir() or root == Path(__file__).resolve().parent.parent:
        raise ValueError("缺少活动工作区，不能向内置 Skill 目录写入素材。")
    return root


def workspace_path(value: str) -> Path:
    path = Path(value).expanduser()
    path = (workspace_root() / path).resolve()
    if not path.is_relative_to(workspace_root()):
        raise ValueError("输入和输出必须位于当前工作区内。")
    return path


def context_text(element) -> str:
    return " ".join(node.text for node in element.iter() if node.tag.rsplit("}", 1)[-1] == "t" and node.text)


def read_part(archive: ZipFile, name: str) -> bytes:
    info = archive.getinfo(name)
    if info.file_size > MAX_IMAGE_BYTES:
        raise ValueError(f"文档部件超过 10 MB：{name}")
    return archive.read(info)


def relationships(archive: ZipFile, part: str) -> dict:
    path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    return {node.get("Id"): node for node in fromstring(read_part(archive, path))} if path in archive.namelist() else {}


def target_part(part: str, target: str) -> str:
    target = unquote(target).replace("\\", "/")
    return posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(part), target))


def office_pictures(source: Path, warnings: list[str]):
    prefix = "word" if source.suffix.lower() == ".docx" else "ppt"
    pattern = r"word/(?:document|header\d+|footer\d+)\.xml" if prefix == "word" else r"ppt/slides/slide\d+\.xml"
    with ZipFile(source) as archive:
        parts = sorted(
            (name for name in archive.namelist() if re.fullmatch(pattern, name)),
            key=lambda name: (int(re.search(r"(\d+)\.xml$", name).group(1)) if re.search(r"(\d+)\.xml$", name) else 0, name),
        )
        if prefix == "ppt":
            presentation = "ppt/presentation.xml"
            rels = relationships(archive, presentation)
            parts = []
            for node in fromstring(read_part(archive, presentation)).iter():
                if node.tag.rsplit("}", 1)[-1] != "sldId":
                    continue
                relation = rels.get(node.get(f"{{{REL}}}id"))
                if relation is None or relation.get("TargetMode") == "External":
                    raise ValueError("演示文稿的页面关系缺失或无效。")
                name = target_part(presentation, relation.get("Target", ""))
                if not name.startswith("ppt/slides/") or name not in archive.namelist():
                    raise ValueError("演示文稿的页面部件缺失。")
                parts.append(name)
        if not parts:
            raise ValueError("文档中没有可读取的正文或幻灯片。")
        for source_index, part in enumerate(parts, 1):
            root = fromstring(read_part(archive, part))
            rels = relationships(archive, part)
            containers = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "p"] if prefix == "word" else [root]
            for index, container in enumerate(containers):
                for node in container.iter():
                    if node.tag.rsplit("}", 1)[-1] not in {"blip", "imagedata"}:
                        continue
                    rid = node.get(f"{{{REL}}}embed") or node.get(f"{{{REL}}}id") or node.get(f"{{{REL}}}link")
                    relation = rels.get(rid)
                    if relation is None:
                        warnings.append(f"{part} 中的图片关系 {rid or '(未知)'} 缺失，未提取。")
                        continue
                    if relation.get("TargetMode") == "External":
                        warnings.append(f"{part} 包含外链图片，未下载；不能将其视为已取得的素材。")
                        continue
                    name = target_part(part, relation.get("Target", ""))
                    if not name.startswith(prefix + "/media/") or name not in archive.namelist():
                        warnings.append(f"{part} 的图片关系没有指向文档内的媒体文件，未提取。")
                        continue
                    nearby = " ".join(context_text(item) for item in containers[max(0, index - 1):index + 2]).strip()
                    occurrence = {"part": part, "context": nearby[:600], "contextTruncated": len(nearby) > 600}
                    if prefix == "word":
                        occurrence["paragraph"] = index + 1
                    else:
                        occurrence["slide"] = source_index
                    try:
                        data = read_part(archive, name)
                    except ValueError as exc:
                        warnings.append(str(exc))
                        continue
                    yield data, Path(name).suffix.lower(), occurrence, "embedded"


def pdf_pictures(source: Path, pages: list[int] | None, rect: list[float] | None, warnings: list[str]):
    import pymupdf

    with pymupdf.open(source) as document:
        if document.needs_pass:
            raise ValueError("PDF 已加密，请先提供可读取的文件。")
        selected = list(dict.fromkeys(pages or range(1, min(len(document), 20) + 1)))
        if not selected or len(selected) > 20 or any(page < 1 or page > len(document) for page in selected):
            raise ValueError("每次请选择 1–20 个有效 PDF 页码（从 1 开始）。")
        if pages is None and len(document) > 20:
            warnings.append(f"仅处理前 20 页；文档共有 {len(document)} 页，其余页可用 --pages 继续。")
        if rect is not None and (len(selected) != 1 or len(rect) != 4 or not all(math.isfinite(value) for value in rect)):
            raise ValueError("--rect 需要 --pages 指定单页，以及四个有限坐标 x0 y0 x1 y1。")
        for number in selected:
            page = document[number - 1]
            if rect is not None:
                clip = pymupdf.Rect(rect)
                if clip.is_empty or clip.is_infinite or not page.rect.contains(clip):
                    raise ValueError("裁切区域必须位于 PDF 页内，并具有正宽度和高度。")
                scale = min(3, 2400 / max(clip.width, clip.height))
                data = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False).tobytes("png")
                text = page.get_textbox(clip * page.derotation_matrix)
                yield data, ".png", {"page": number, "bbox": list(clip), "context": text[:600], "contextTruncated": len(text) > 600}, "page_crop"
                continue
            seen: set[int] = set()
            for image in page.get_images(full=True):
                xref, mask = image[:2]
                if xref in seen:
                    continue
                seen.add(xref)
                if not xref:
                    warnings.append(f"第 {number} 页包含无法直接导出的内联图，请查看页面后按区域裁切。")
                    continue
                original = document.extract_image(xref)
                if not original:
                    warnings.append(f"第 {number} 页有图片未能解码，请按区域裁切。")
                    continue
                data = original["image"]
                suffix = "." + original["ext"]
                if mask:
                    pixmap = pymupdf.Pixmap(pymupdf.Pixmap(document, xref), pymupdf.Pixmap(document, mask))
                    data, suffix = pixmap.tobytes("png"), ".png"
                for box in page.get_image_rects(xref):
                    native_bounds = page.rect * page.derotation_matrix
                    nearby = pymupdf.Rect(native_bounds.x0, max(native_bounds.y0, box.y0 - 36), native_bounds.x1, min(native_bounds.y1, box.y1 + 60))
                    text = page.get_textbox(nearby)
                    yield data, suffix, {"page": number, "bbox": list(box * page.rotation_matrix), "context": text[:600], "contextTruncated": len(text) > 600}, "embedded"
        warnings.append("PDF 矢量图、原生图表和多层组合图未必是独立图片；提取数量不代表图已全部取得。先看页面，必要时用 --pages N --rect x0 y0 x1 y1 导出完整图。")


def usable_picture(data: bytes, suffix: str) -> tuple[bytes, str, int | None, int | None]:
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片超过 PPT 单素材 10 MB 限制，未导出。可选择相关区域裁切。")
    if suffix == ".svg":
        raise ValueError("SVG 尚未通过 Office 的静态图片约束核验，未导出为可直接插图的素材；可使用现有 SVG 入口核验或提供 PNG。")
    with Image.open(BytesIO(data)) as picture:
        width, height = picture.size
        if width * height > 40_000_000:
            raise ValueError("图片尺寸过大，未导出。可选择相关区域裁切。")
        if picture.format in FORMATS:
            picture.verify()
            return data, FORMATS[picture.format], width, height
        output = BytesIO()
        picture.convert("RGBA" if "A" in picture.getbands() else "RGB").save(output, format="PNG")
        if output.tell() > MAX_IMAGE_BYTES:
            raise ValueError("图片转为 PNG 后超过 10 MB，未导出。")
        return output.getvalue(), "png", width, height


def extract_source_images(input_path: str, output_dir: str, pages: list[int] | None = None, rect: list[float] | None = None) -> dict:
    source, destination = workspace_path(input_path), workspace_path(output_dir)
    if not source.is_file() or source.stat().st_size > MAX_TOTAL_BYTES:
        raise ValueError("输入必须是工作区内不超过 100 MB 的文件。")
    if source.suffix.lower() not in {".docx", ".pptx", ".pdf"}:
        raise ValueError("仅支持 DOCX、PPTX、PDF；独立图片可直接用于 PPT，无需提取。")
    if source.suffix.lower() != ".pdf" and (pages is not None or rect is not None):
        raise ValueError("--pages 和 --rect 仅用于 PDF。")
    if destination.exists():
        raise FileExistsError("输出目录已存在；请选择新目录，不覆盖已有素材。")
    warnings: list[str] = []
    pictures = pdf_pictures(source, pages, rect, warnings) if source.suffix.lower() == ".pdf" else office_pictures(source, warnings)
    assets: list[dict] = []
    by_hash: dict[str, dict] = {}
    total = 0
    # Validate and collect before creating output, so malformed inputs leave no partial assets.
    for data, suffix, occurrence, method in pictures:
        try:
            data, extension, width, height = usable_picture(data, suffix)
        except (OSError, ValueError, Image.DecompressionBombError) as exc:
            warnings.append(f"{occurrence.get('part') or 'PDF 第 ' + str(occurrence.get('page')) + ' 页'}：{exc}")
            continue
        digest = hashlib.sha256(data).hexdigest()
        if digest in by_hash:
            by_hash[digest]["occurrences"].append(occurrence)
            continue
        total += len(data)
        if len(assets) >= 200 or total > MAX_TOTAL_BYTES:
            raise ValueError("本批素材超过 200 张或 100 MB；PDF 请按相关页面分批提取。")
        asset = {"data": data, "extension": extension, "width": width, "height": height, "sha256": digest, "method": method, "occurrences": [occurrence]}
        assets.append(asset)
        by_hash[digest] = asset
    destination.mkdir(parents=True)
    manifest = {"source": source.relative_to(workspace_root()).as_posix(), "assets": [], "warnings": list(dict.fromkeys(warnings))}
    for index, asset in enumerate(assets, 1):
        path = destination / f"image-{index:03d}.{asset['extension']}"
        with path.open("xb") as output:
            output.write(asset.pop("data"))
        asset["assetPath"] = path.relative_to(workspace_root()).as_posix()
        manifest["assets"].append(asset)
    manifest_path = destination / "manifest.json"
    with manifest_path.open("x", encoding="utf-8") as output:
        json.dump(manifest, output, ensure_ascii=False, indent=2)
    preview = [{**asset, "occurrences": asset["occurrences"][:4], "occurrenceCount": len(asset["occurrences"])} for asset in assets[:12]]
    return {
        "ok": True, "manifestPath": manifest_path.relative_to(workspace_root()).as_posix(),
        "source": manifest["source"], "assets": preview, "assetCount": len(assets),
        "warnings": manifest["warnings"][:12], "warningCount": len(manifest["warnings"]),
        "truncated": len(assets) > 12 or len(manifest["warnings"]) > 12 or any(len(asset["occurrences"]) > 4 for asset in assets),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--pages", type=int, nargs="+")
    parser.add_argument("--rect", type=float, nargs=4, metavar=("X0", "Y0", "X1", "Y1"))
    args = parser.parse_args()
    try:
        result = extract_source_images(args.input, args.output_dir, args.pages, args.rect)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
