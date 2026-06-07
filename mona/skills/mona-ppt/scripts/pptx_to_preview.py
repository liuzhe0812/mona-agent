"""Convert PPTX to PNG preview images using LibreOffice headless.

Usage:
    python pptx_to_preview.py <pptx_path> [output_dir]

If output_dir is not specified, saves to <pptx_dir>/preview/
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def find_libreoffice() -> str | None:
    """Find LibreOffice soffice executable."""
    candidates = [
        shutil.which("soffice"),
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def pptx_to_preview(pptx_path: str, output_dir: str | None = None) -> tuple[bool, str]:
    """Convert PPTX to PNG preview images.

    Uses LibreOffice headless mode to export slides as PNGs.
    Falls back to a simple slide-count report if LibreOffice is unavailable.
    """
    pptx = Path(pptx_path)
    if not pptx.exists():
        return False, f"PPTX not found: {pptx_path}"

    out = Path(output_dir) if output_dir else pptx.parent / "preview"
    out.mkdir(parents=True, exist_ok=True)

    soffice = find_libreoffice()
    if not soffice:
        return _fallback_preview(pptx, out)

    try:
        result = subprocess.run(
            [
                soffice,
                "--headless",
                "--convert-to", "png",
                "--outdir", str(out),
                str(pptx),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            return _fallback_preview(pptx, out)

        generated = list(out.glob("*.png"))
        if not generated:
            return _fallback_preview(pptx, out)

        existing_previews = list(out.glob("slide_*.png"))
        if existing_previews:
            count = len(existing_previews)
            return True, f"Preview ready ({count} slides)"

        if len(generated) == 1:
            generated[0].rename(out / "slide_1.png")
            return True, "Preview ready (1 combined image)"
        else:
            for i, f in enumerate(sorted(generated), 1):
                f.rename(out / f"slide_{i}.png")
            return True, f"Preview ready ({len(generated)} slides)"

    except subprocess.TimeoutExpired:
        return _fallback_preview(pptx, out)
    except Exception:
        return _fallback_preview(pptx, out)


def _fallback_preview(pptx_path: Path, out: Path) -> tuple[bool, str]:
    """Create placeholder preview images when LibreOffice is unavailable.

    Uses python-pptx to count slides and creates simple numbered placeholders.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
        from pptx import Presentation

        prs = Presentation(str(pptx_path))
        slide_count = len(prs.slides)

        if slide_count == 0:
            return False, "No slides found"

        width, height = 1280, 720

        for i in range(1, slide_count + 1):
            img = Image.new("RGB", (width, height), "white")
            draw = ImageDraw.Draw(img)

            draw.rectangle([(2, 2), (width - 3, height - 3)], outline="#CCCCCC", width=2)

            label = f"Slide {i}"
            try:
                font = ImageFont.load_default(size=48)
            except Exception:
                font = ImageFont.load_default()
            bbox = draw.textbbox((0, 0), label, font=font)
            text_w = bbox[2] - bbox[0]
            text_h = bbox[3] - bbox[1]
            draw.text(
                ((width - text_w) // 2, (height - text_h) // 2),
                label,
                fill="#999999",
                font=font,
            )

            img.save(str(out / f"slide_{i}.png"))

        return True, f"Placeholder preview ready ({slide_count} slides)"

    except ImportError:
        return False, "python-pptx or Pillow not available"
    except Exception as e:
        return False, f"Preview generation failed: {e}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert PPTX to PNG preview images")
    parser.add_argument("pptx_path", help="Path to PPTX file")
    parser.add_argument("output_dir", nargs="?", help="Output directory for PNGs")
    args = parser.parse_args()

    success, message = pptx_to_preview(args.pptx_path, args.output_dir)
    print(message)
    if not success:
        sys.exit(1)
