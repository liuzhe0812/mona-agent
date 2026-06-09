"""从 logo.png 生成圆角透明图标，分发到 src-tauri/icons/"""
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "src-tauri" / "icons"
SRC = ROOT / "logo.png"
CORNER_RATIO = 0.22  # 圆角比例


def add_rounded_corners(img: Image.Image, corner_ratio: float = CORNER_RATIO) -> Image.Image:
    """给图片四角加透明圆角"""
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


def premultiply_alpha(img: Image.Image) -> Image.Image:
    """对 RGBA 图像做 alpha 预乘，确保透明像素的 RGB 不会是纯黑

    Pillow 的 LANCZOS resize 会将 alpha=0 的像素 RGB 重置为 (0,0,0)，
    而 Windows 在某些场景（桌面快捷方式、任务栏）不正确处理 alpha 通道，
    会直接使用 RGB 值渲染，导致透明区域显示为黑色。

    通过将透明/半透明像素的 RGB 向图标主色调混合，即使 alpha 被忽略
    也不会出现黑角。必须在 resize 之后调用。
    """
    w, h = img.size
    pixels = img.load()

    # 采样中心区域的不透明像素主色调（中心 50% 区域）
    margin = int(min(w, h) * 0.25)
    edge_colors = []
    step = max(1, min(w, h) // 50)  # 采样步长，避免遍历所有像素
    for x in range(margin, w - margin, step):
        for y in range(margin, h - margin, step):
            r, g, b, a = pixels[x, y]
            if a == 255:
                edge_colors.append((r, g, b))

    if not edge_colors:
        # 回退：采样所有不透明像素
        for x in range(0, w, step):
            for y in range(0, h, step):
                r, g, b, a = pixels[x, y]
                if a == 255:
                    edge_colors.append((r, g, b))

    if not edge_colors:
        return img

    # 取主色调的中位数作为混合目标色
    edge_r = sorted(c[0] for c in edge_colors)[len(edge_colors) // 2]
    edge_g = sorted(c[1] for c in edge_colors)[len(edge_colors) // 2]
    edge_b = sorted(c[2] for c in edge_colors)[len(edge_colors) // 2]

    # 对每个像素做 alpha 预乘
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a < 255:
                # 将 RGB 向主色调混合，权重由 alpha 决定
                alpha_f = a / 255.0
                r = int(r * alpha_f + edge_r * (1 - alpha_f))
                g = int(g * alpha_f + edge_g * (1 - alpha_f))
                b = int(b * alpha_f + edge_b * (1 - alpha_f))
                pixels[x, y] = (r, g, b, a)

    return img


def save_png(img: Image.Image, path: Path, size: int) -> None:
    """缩放并保存 PNG，resize 后做 alpha 预乘防止黑角"""
    resized = img.resize((size, size), Image.LANCZOS)
    resized = premultiply_alpha(resized)
    resized.save(path, "PNG")
    print(f"  ✓ {size}x{size} → {path.name}")


def save_ico(img: Image.Image, path: Path) -> None:
    """生成 ICO（包含多个尺寸，全部使用 PNG 格式以保留 alpha 通道）

    Windows ICO 的 BMP DIB 条目不支持 alpha 通道透明度（依赖 AND 掩码），
    会导致透明区域变黑。使用 bitmap_format='png' 让所有条目都用 PNG 编码，
    Windows 7+ 完全支持此格式，alpha 通道正确保留。
    """
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [premultiply_alpha(img.resize((s, s), Image.LANCZOS)) for s in sizes]
    images[-1].save(
        path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[:-1],
        bitmap_format="png",
    )
    print(f"  ✓ ICO PNG ({', '.join(str(s) for s in sizes)})")


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
