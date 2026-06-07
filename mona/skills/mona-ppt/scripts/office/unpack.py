"""Unpack Office files (DOCX, PPTX, XLSX) for editing.

Extracts the ZIP archive and pretty-prints XML files.

Usage:
    python unpack.py <office_file> <output_dir>

Examples:
    python unpack.py presentation.pptx unpacked/
"""

import argparse
import io
import os
import sys
import zipfile
from pathlib import Path

if os.name == "nt" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import defusedxml.minidom


def unpack(
    input_file: str,
    output_directory: str,
) -> tuple[bool, str]:
    input_path = Path(input_file)
    output_path = Path(output_directory)

    if not input_path.exists():
        return False, f"Error: {input_file} does not exist"

    suffix = input_path.suffix.lower()
    if suffix not in {".docx", ".pptx", ".xlsx"}:
        return False, f"Error: {input_file} must be a .docx, .pptx, or .xlsx file"

    try:
        output_path.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(output_path)

        xml_files = list(output_path.rglob("*.xml")) + list(output_path.rglob("*.rels"))
        for xml_file in xml_files:
            _pretty_print_xml(xml_file)

        return True, f"Unpacked {input_file} ({len(xml_files)} XML files)"

    except zipfile.BadZipFile:
        return False, f"Error: {input_file} is not a valid Office file"
    except Exception as e:
        return False, f"Error unpacking: {e}"


def _pretty_print_xml(xml_file: Path) -> None:
    try:
        content = xml_file.read_text(encoding="utf-8")
        dom = defusedxml.minidom.parseString(content)
        xml_file.write_bytes(dom.toprettyxml(indent="  ", encoding="utf-8"))
    except Exception:
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Unpack an Office file (DOCX, PPTX, XLSX) for editing",
    )
    parser.add_argument("input_file", help="Office file to unpack")
    parser.add_argument("output_directory", help="Output directory")
    args = parser.parse_args()

    success, message = unpack(args.input_file, args.output_directory)
    print(message)

    if not success:
        sys.exit(1)
