"""Create thumbnail images from PowerPoint presentation slides.

Usage:
    python thumbnail.py <input.pptx> [output_dir] [--cols N]

Examples:
    python thumbnail.py presentation.pptx
    python thumbnail.py template.pptx thumbnails --cols 4
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

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None

THUMBNAIL_WIDTH = 300
DEFAULT_COLS = 3
MAX_COLS = 6
JPEG_QUALITY = 95
GRID_PADDING = 20
BORDER_WIDTH = 2


def extract_slide_thumbnails(pptx_path: Path, output_dir: Path) -> list[Path]:
    """Extract slide thumbnails from PPTX file.

    PPTX files may contain thumbnail images in docProps/thumbnail.jpeg
    or individual slide thumbnails. This extracts what's available.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    thumbnails = []

    try:
        with zipfile.ZipFile(pptx_path, "r") as zf:
            names = zf.namelist()

            # Try to extract individual slide thumbnails
            # PowerPoint saves these as ppt/slides/slideN.xml with optional thumbnails
            slide_files = sorted(
                [n for n in names if n.startswith("ppt/slides/slide") and n.endswith(".xml")],
                key=lambda x: int("".join(c for c in x if c.isdigit()) or "0"),
            )

            # Check for existing thumbnails in docProps/
            for name in names:
                if name.startswith("docProps/thumbnail"):
                    data = zf.read(name)
                    ext = Path(name).suffix
                    out_path = output_dir / f"thumbnail{ext}"
                    out_path.write_bytes(data)
                    thumbnails.append(out_path)
                    break

    except zipfile.BadZipFile:
        print(f"Warning: {pptx_path} is not a valid PPTX file", file=sys.stderr)

    return thumbnails


def create_placeholder_grid(
    slide_count: int,
    cols: int,
    width: int,
    output_path: Path,
) -> str:
    """Create a grid of placeholder thumbnails when image extraction isn't available."""
    if Image is None:
        # Fallback: just create a text file listing slides
        output_path = output_path.with_suffix(".txt")
        lines = [f"Slide {i+1}" for i in range(slide_count)]
        output_path.write_text("\n".join(lines), encoding="utf-8")
        return str(output_path)

    height = int(width * 9 / 16)  # 16:9 aspect
    rows = (slide_count + cols - 1) // cols
    grid_w = cols * width + (cols + 1) * GRID_PADDING
    grid_h = rows * (height + 40) + (rows + 1) * GRID_PADDING

    grid = Image.new("RGB", (grid_w, grid_h), "white")
    draw = ImageDraw.Draw(grid)

    try:
        font = ImageFont.load_default(size=16)
    except Exception:
        font = ImageFont.load_default()

    for i in range(slide_count):
        row, col = i // cols, i % cols
        x = col * width + (col + 1) * GRID_PADDING
        y = row * (height + 40) + (row + 1) * GRID_PADDING

        # Draw slide placeholder
        draw.rectangle(
            [(x, y), (x + width - 1, y + height - 1)],
            outline="gray",
            width=BORDER_WIDTH,
        )
        # Draw slide number
        label = f"Slide {i + 1}"
        bbox = draw.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        draw.text(
            (x + (width - text_w) // 2, y + height // 2 - 8),
            label,
            fill="gray",
            font=font,
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    grid.save(str(output_path), quality=JPEG_QUALITY)
    return str(output_path)


def main():
    parser = argparse.ArgumentParser(
        description="Create thumbnail grids from PowerPoint slides.",
    )
    parser.add_argument("input", help="Input PowerPoint file (.pptx)")
    parser.add_argument(
        "output_prefix",
        nargs="?",
        default="thumbnails",
        help="Output prefix for image files (default: thumbnails)",
    )
    parser.add_argument(
        "--cols",
        type=int,
        default=DEFAULT_COLS,
        help=f"Number of columns (default: {DEFAULT_COLS}, max: {MAX_COLS})",
    )
    args = parser.parse_args()

    cols = min(args.cols, MAX_COLS)
    input_path = Path(args.input)

    if not input_path.exists() or input_path.suffix.lower() != ".pptx":
        print(f"Error: Invalid PowerPoint file: {args.input}", file=sys.stderr)
        sys.exit(1)

    output_path = Path(f"{args.output_prefix}.jpg")

    # Count slides
    slide_count = 0
    try:
        with zipfile.ZipFile(input_path, "r") as zf:
            slide_count = sum(
                1 for n in zf.namelist()
                if n.startswith("ppt/slides/slide") and n.endswith(".xml")
                and "Layout" not in n and "Master" not in n
            )
    except zipfile.BadZipFile:
        print(f"Error: {input_path} is not a valid PPTX file", file=sys.stderr)
        sys.exit(1)

    if slide_count == 0:
        print("Error: No slides found", file=sys.stderr)
        sys.exit(1)

    # Try extracting real thumbnails first
    temp_dir = Path(f"{args.output_prefix}_temp")
    thumbnails = extract_slide_thumbnails(input_path, temp_dir)

    if thumbnails:
        print(f"Extracted {len(thumbnails)} thumbnail(s)")
        for t in thumbnails:
            print(f"  {t}")
    else:
        # Fall back to placeholder grid
        result = create_placeholder_grid(slide_count, cols, THUMBNAIL_WIDTH, output_path)
        print(f"Created placeholder grid ({slide_count} slides): {result}")


if __name__ == "__main__":
    main()
