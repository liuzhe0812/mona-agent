"""从 logo.png 生成圆角透明图标，分发到 src-tauri/icons/"""
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "src-tauri" / "icons"
SRC = ROOT / "logo.png"
CORNER_RATIO = 0.22  # 圆角比例


def add_rounded_corners(img: Image.Image, corner_ratio: float = CORNER_RATIO) -> Image.Image:
    """给图片四角加透明圆角，保留白色背景"""
    w, h = img.size
    r = int(min(w, h) * corner_ratio)

    # 用 rounded_rectangle 画蒙版：圆角区域=255(不透明)，四角=0(透明)
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)

    # 确保 RGBA
    img = img.convert("RGBA")
    img.putalpha(mask)
    return img


def save_png(img: Image.Image, path: Path, size: int) -> None:
    """缩放并保存 PNG"""
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(path, "PNG")
    print(f"  ✓ {size}x{size} → {path.name}")


def save_ico(img: Image.Image, path: Path) -> None:
    """生成 ICO（包含多个尺寸）"""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [img.resize((s, s), Image.LANCZOS) for s in sizes]
    images[0].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=images[1:])
    print(f"  ✓ ICO ({', '.join(str(s) for s in sizes)})")


def main():
    print("Generating rounded-corner icons from logo.png (Python/Pillow)...\n")

    src_img = Image.open(SRC)
    print(f"  Source: {src_img.size[0]}x{src_img.size[1]}\n")

    # 加圆角
    rounded = add_rounded_corners(src_img)

    # 核心 PNG
    for size, name in [
        (32, "32x32.png"),
        (64, "64x64.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (1024, "icon.png"),
    ]:
        save_png(rounded, ICONS_DIR / name, size)

    # Windows Store tiles
    for size, name in [
        (30, "Square30x30Logo.png"),
        (44, "Square44x44Logo.png"),
        (71, "Square71x71Logo.png"),
        (89, "Square89x89Logo.png"),
        (107, "Square107x107Logo.png"),
        (142, "Square142x142Logo.png"),
        (150, "Square150x150Logo.png"),
        (284, "Square284x284Logo.png"),
        (310, "Square310x310Logo.png"),
        (50, "StoreLogo.png"),
    ]:
        save_png(rounded, ICONS_DIR / name, size)

    # ICO
    save_ico(rounded, ICONS_DIR / "icon.ico")

    print("\n✅ Done!")


if __name__ == "__main__":
    main()
