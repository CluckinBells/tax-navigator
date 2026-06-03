# Финальный брендовый комплект: иконка-знак (№1) + горизонтальный логотип (№2/№3).
# Выдаёт все нужные форматы для бота, сайта, документов и соцсетей.

from PIL import Image, ImageDraw, ImageFont
import os

FONTS = r"C:\Users\XDot PC\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\978ac07b-90e6-4f0f-9377-9a70bf8af690\fe74928c-90de-470f-b3da-57f8c7b17749\skills\canvas-design\canvas-fonts"
OUT = r"C:\Users\XDot PC\OneDrive\Desktop\tax-navigator\brand"
os.makedirs(OUT, exist_ok=True)

SS = 4
INDIGO = (99, 102, 241)
VIOLET = (168, 85, 247)
INK = (10, 11, 20)        # фон тёмной версии = фон сайта
INK_TEXT = (15, 17, 32)
PAPER = (247, 248, 252)

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size * SS)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def grad(w, h, c1, c2):
    img = Image.new("RGB", (w, h), c1)
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = ((x / w) + (y / h)) / 2
            px[x, y] = lerp(c1, c2, t)
    return img

def squircle_mask(w, h, r):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    return m

def mark_layer(size, line_color, line_w_ratio=0.05, pad_ratio=0.26):
    """Прозрачный слой со знаком «рост+стрелка» — для наложения куда угодно."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pad = size * pad_ratio
    x0, y0, x1, y1 = pad, pad, size - pad, size - pad
    w = x1 - x0; h = y1 - y0
    lw = int(size * line_w_ratio)
    pts = [
        (x0 + 0.04 * w, y0 + 0.70 * h),
        (x0 + 0.34 * w, y0 + 0.40 * h),
        (x0 + 0.54 * w, y0 + 0.58 * h),
        (x0 + 0.94 * w, y0 + 0.12 * h),
    ]
    d.line(pts, fill=line_color, width=lw, joint="curve")
    ax, ay = pts[-1]
    s = 0.22 * w
    d.line([(ax - s, ay), (ax, ay), (ax, ay + s)], fill=line_color, width=lw, joint="curve")
    rr = lw // 2
    for (px, py) in [pts[0], pts[-1], (ax - s, ay), (ax, ay + s)]:
        d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=line_color)
    return layer

def icon(size_out, with_bg=True, corner=0.235):
    """Иконка-плашка. with_bg=False -> прозрачный фон, белый знак (для тёмных мест)."""
    S = size_out * SS
    if with_bg:
        base = grad(S, S, INDIGO, VIOLET).convert("RGBA")
        base.putalpha(squircle_mask(S, S, int(S * corner)))
        base.alpha_composite(mark_layer(S, (255, 255, 255, 255)))
    else:
        base = mark_layer(S, (255, 255, 255, 255))
    return base.resize((size_out, size_out), Image.LANCZOS)

def bot_avatar(size_out):
    """Аватар бота: полноэкранный градиент + белый знак, без прозрачности.
    Telegram сам обрежет в круг, поэтому плашку не используем — знак крупнее и читаемее."""
    S = size_out * SS
    base = grad(S, S, INDIGO, VIOLET).convert("RGBA")
    base.alpha_composite(mark_layer(S, (255, 255, 255, 255), line_w_ratio=0.052, pad_ratio=0.30))
    return base.resize((size_out, size_out), Image.LANCZOS)

def horizontal(fname, dark):
    W, H = 1400 * SS, 420 * SS
    bg = INK if dark else PAPER
    img = Image.new("RGBA", (W, H), bg + (255,))
    d = ImageDraw.Draw(img)
    ic = 300 * SS
    icon_img = grad(ic, ic, INDIGO, VIOLET).convert("RGBA")
    icon_img.putalpha(squircle_mask(ic, ic, int(ic * 0.235)))
    icon_img.alpha_composite(mark_layer(ic, (255, 255, 255, 255)))
    iy = (H - ic) // 2
    img.alpha_composite(icon_img, (70 * SS, iy))
    tx = 70 * SS + ic + 64 * SS
    f1 = font("Jura-Medium.ttf", 86)
    f2 = font("IBMPlexMono-Regular.ttf", 34)
    ink = (245, 247, 255) if dark else INK_TEXT
    mute = (150, 156, 180) if dark else (110, 116, 140)
    d.text((tx, H/2 - 100*SS), "Налоговый", font=f1, fill=ink)
    d.text((tx, H/2 - 6*SS), "навигатор", font=f1, fill=ink)
    bb = d.textbbox((tx, H/2 - 6*SS), "навигатор", font=f1)
    d.ellipse([bb[2]+14*SS, bb[3]-24*SS, bb[2]+14*SS+20*SS, bb[3]-4*SS], fill=VIOLET)
    d.text((tx+4*SS, H/2 + 96*SS), "сравнение режимов ИП · 2026", font=f2, fill=mute)
    img.resize((1400, 420), Image.LANCZOS).save(os.path.join(OUT, fname))

def horizontal_transparent(fname, dark_text):
    """Горизонтальный логотип на ПРОЗРАЧНОМ фоне — кладётся на любой фон."""
    W, H = 1400 * SS, 420 * SS
    img = Image.new("RGBA", (W, H), (0,0,0,0))
    d = ImageDraw.Draw(img)
    ic = 300 * SS
    icon_img = grad(ic, ic, INDIGO, VIOLET).convert("RGBA")
    icon_img.putalpha(squircle_mask(ic, ic, int(ic * 0.235)))
    icon_img.alpha_composite(mark_layer(ic, (255, 255, 255, 255)))
    iy = (H - ic) // 2
    img.alpha_composite(icon_img, (70 * SS, iy))
    tx = 70 * SS + ic + 64 * SS
    f1 = font("Jura-Medium.ttf", 86)
    f2 = font("IBMPlexMono-Regular.ttf", 34)
    ink = (245, 247, 255) if not dark_text else INK_TEXT
    mute = (150, 156, 180) if not dark_text else (110, 116, 140)
    d.text((tx, H/2 - 100*SS), "Налоговый", font=f1, fill=ink)
    d.text((tx, H/2 - 6*SS), "навигатор", font=f1, fill=ink)
    bb = d.textbbox((tx, H/2 - 6*SS), "навигатор", font=f1)
    d.ellipse([bb[2]+14*SS, bb[3]-24*SS, bb[2]+14*SS+20*SS, bb[3]-4*SS], fill=VIOLET)
    d.text((tx+4*SS, H/2 + 96*SS), "сравнение режимов ИП · 2026", font=f2, fill=mute)
    img.resize((1400, 420), Image.LANCZOS).save(os.path.join(OUT, fname))

# === Финальный комплект ===
# Иконка-знак
icon(512, with_bg=True).save(os.path.join(OUT, "icon-512.png"))                 # основная иконка
icon(192, with_bg=True).save(os.path.join(OUT, "icon-192.png"))                 # PWA/мелкая
icon(64, with_bg=True).save(os.path.join(OUT, "favicon-64.png"))                # фавикон
icon(512, with_bg=False).save(os.path.join(OUT, "icon-white-transparent.png"))  # белый знак, прозрачный
bot_avatar(512).save(os.path.join(OUT, "bot-avatar-512.png"))                   # аватар бота (Telegram обрежет в круг)

# Горизонтальный логотип
horizontal("logo-horizontal-light.png", dark=False)
horizontal("logo-horizontal-dark.png", dark=True)
horizontal_transparent("logo-horizontal-on-dark.png", dark_text=False)   # для тёмных фонов
horizontal_transparent("logo-horizontal-on-light.png", dark_text=True)   # для светлых фонов

print("FINAL SET:")
for f in sorted(os.listdir(OUT)):
    if f.endswith(".png"):
        print("  ", f)
