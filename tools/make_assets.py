"""Generates the extension icons and the pictures used by test/index.html.

Usage: python tools/make_assets.py   (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SS = 4  # supersampling


def font(size):
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf", "Arial Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def icon(size, bg, moon):
    s = size * SS
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=bg)
    r = s * 0.30
    cx, cy = s * 0.5, s * 0.5
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=moon)
    o = r * 0.62
    d.ellipse([cx - r + o, cy - r - o * 0.55, cx + r + o, cy + r - o * 0.55], fill=bg)
    return im.resize((size, size), Image.LANCZOS)


def make_icons():
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        icon(size, (31, 35, 48, 255), (245, 200, 76, 255)).save(out / f"on-{size}.png")
        icon(size, (96, 102, 114, 255), (205, 209, 216, 255)).save(out / f"off-{size}.png")


def text_logo(text, color, size=(260, 80), bg=(0, 0, 0, 0), mark=None):
    im = Image.new("RGBA", size, bg)
    d = ImageDraw.Draw(im)
    x = 12
    if mark:
        d.ellipse([12, 16, 60, 64], fill=mark)
        x = 72
    d.text((x, size[1] // 2), text, fill=color, font=font(34), anchor="lm")
    return im


def make_test_images():
    out = ROOT / "test" / "img"
    out.mkdir(parents=True, exist_ok=True)
    # Black logo on transparent background: would vanish on a dark page.
    text_logo("BlackLogo", (17, 17, 17, 255)).save(out / "logo-black.png")
    # White logo on transparent background, made for a dark header.
    text_logo("WhiteLogo", (255, 255, 255, 255)).save(out / "logo-white.png")
    # Colourful logo with dark text.
    text_logo("Colorful", (20, 20, 20, 255), mark=(230, 60, 50, 255)).save(out / "logo-color.png")
    # Light picture with dark text (a scheme / screenshot).
    doc = Image.new("RGB", (360, 200), (255, 255, 255))
    d = ImageDraw.Draw(doc)
    d.rectangle([20, 30, 150, 90], outline=(0, 0, 0), width=3)
    d.rectangle([210, 110, 340, 170], outline=(0, 0, 0), width=3)
    d.line([150, 60, 275, 110], fill=(0, 0, 0), width=3)
    d.text((85, 60), "Start", fill=(0, 0, 0), font=font(22), anchor="mm")
    d.text((275, 140), "Finish", fill=(0, 0, 0), font=font(22), anchor="mm")
    doc.save(out / "scheme.png")
    # A "photo": smooth colourful gradient.
    w, h = 360, 200
    photo = Image.new("RGB", (w, h))
    px = photo.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (int(40 + 200 * x / w), int(120 + 100 * y / h), int(200 - 150 * x / w))
    ImageDraw.Draw(photo).ellipse([250, 30, 320, 100], fill=(255, 230, 120))
    photo.save(out / "photo.jpg", quality=90)
    # Small dark icon used as a CSS background.
    ic = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    di = ImageDraw.Draw(ic)
    di.ellipse([8, 8, 56, 56], outline=(20, 20, 20, 255), width=6)
    di.line([20, 32, 30, 44, 46, 20], fill=(20, 20, 20, 255), width=6)
    ic.save(out / "icon-dark.png")
    # Dark SVG logo.
    (out / "logo-black.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60">'
        '<rect x="4" y="10" width="40" height="40" rx="8" fill="#111"/>'
        '<text x="56" y="42" font-family="Arial" font-weight="bold" font-size="30" fill="#111">SVG</text>'
        "</svg>",
        encoding="utf-8",
    )


if __name__ == "__main__":
    make_icons()
    make_test_images()
    print("done")
