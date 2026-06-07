"""Pack a directory into a DOCX, PPTX, or XLSX file.

Condenses XML formatting and creates the Office file.

Usage:
    python pack.py <input_directory> <output_file> [--original <file>]

Examples:
    python pack.py unpacked/ output.pptx --original input.pptx
"""

import argparse
import io
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

if os.name == "nt" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import defusedxml.minidom


def pack(
    input_directory: str,
    output_file: str,
) -> tuple[bool, str]:
    input_dir = Path(input_directory)
    output_path = Path(output_file)
    suffix = output_path.suffix.lower()

    if not input_dir.is_dir():
        return False, f"Error: {input_dir} is not a directory"

    if suffix not in {".docx", ".pptx", ".xlsx"}:
        return False, f"Error: {output_file} must be a .docx, .pptx, or .xlsx file"

    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_content_dir = Path(temp_dir) / "content"
            shutil.copytree(input_dir, temp_content_dir)

            for pattern in ["*.xml", "*.rels"]:
                for xml_file in temp_content_dir.rglob(pattern):
                    _condense_xml(xml_file)

            output_path.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in temp_content_dir.rglob("*"):
                    if f.is_file():
                        zf.write(f, f.relative_to(temp_content_dir))
    except Exception as e:
        try:
            if output_path.exists():
                output_path.unlink()
        except OSError:
            pass
        return False, f"Error packing: {e}"

    if not output_path.exists():
        return False, "Error: output file was not written to disk"

    return True, f"Packed {input_dir} -> {output_path.resolve()}"


def _condense_xml(xml_file: Path) -> None:
    try:
        with open(xml_file, encoding="utf-8") as f:
            dom = defusedxml.minidom.parse(f)

        for element in dom.getElementsByTagName("*"):
            if element.tagName.endswith(":t"):
                continue
            for child in list(element.childNodes):
                if (
                    child.nodeType == child.TEXT_NODE
                    and child.nodeValue
                    and child.nodeValue.strip() == ""
                ) or child.nodeType == child.COMMENT_NODE:
                    element.removeChild(child)

        xml_file.write_bytes(dom.toxml(encoding="UTF-8"))
    except Exception as e:
        print(f"Warning: Failed to condense {xml_file.name}: {e}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Pack a directory into a DOCX, PPTX, or XLSX file",
    )
    parser.add_argument("input_directory", help="Unpacked Office document directory")
    parser.add_argument("output_file", help="Output Office file (.docx/.pptx/.xlsx)")
    parser.add_argument(
        "--original",
        help="Original file (reserved for future validation)",
    )
    args = parser.parse_args()

    success, message = pack(args.input_directory, args.output_file)
    print(message)

    if not success:
        sys.exit(1)
