import sys
from pathlib import Path

import pymupdf

# Converts each page of a PDF to a PNG image.


def convert(pdf_path, output_dir, max_dim=1000):
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(pdf_path) as document:
        for i, page in enumerate(document):
            scale = min(200 / 72, max_dim / max(page.rect.width, page.rect.height))
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            image_path = destination / f"page_{i + 1}.png"
            pixmap.save(image_path)
            print(f"Saved page {i + 1} as {image_path} (size: {(pixmap.width, pixmap.height)})")

        print(f"Converted {len(document)} pages to PNG images")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: convert_pdf_to_images.py [input pdf] [output directory]")
        sys.exit(1)
    pdf_path = sys.argv[1]
    output_directory = sys.argv[2]
    convert(pdf_path, output_directory)
