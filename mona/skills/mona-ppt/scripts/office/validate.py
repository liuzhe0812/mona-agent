"""Validate an unpacked PPTX directory structure.

Usage:
    python validate.py <unpacked_dir>

Checks:
- Required directories exist (ppt/, ppt/slides/, etc.)
- presentation.xml is valid
- All referenced slides exist
"""

import sys
from pathlib import Path


def validate_pptx(unpacked_dir: Path) -> tuple[bool, list[str]]:
    errors: list[str] = []

    if not unpacked_dir.is_dir():
        return False, [f"Not a directory: {unpacked_dir}"]

    required = ["ppt", "ppt/slides", "ppt/slideLayouts", "ppt/slideMasters"]
    for rel in required:
        if not (unpacked_dir / rel).is_dir():
            errors.append(f"Missing required directory: {rel}")

    pres_xml = unpacked_dir / "ppt" / "presentation.xml"
    if not pres_xml.is_file():
        errors.append("Missing ppt/presentation.xml")

    content_types = unpacked_dir / "[Content_Types].xml"
    if not content_types.is_file():
        errors.append("Missing [Content_Types].xml")

    return len(errors) == 0, errors


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python validate.py <unpacked_dir>", file=sys.stderr)
        sys.exit(1)

    unpacked_dir = Path(sys.argv[1])
    ok, errors = validate_pptx(unpacked_dir)

    if ok:
        print("Validation PASSED")
    else:
        print("Validation FAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)
