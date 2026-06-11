# Оформление Telegram-канала «Налоговый навигатор»:
#   channel-avatar-512.png  — аватар: тёмный фирменный фон + ГРАДИЕНТНАЯ стрелка
#                             (бот — градиентный фон с белой стрелкой; канал отличим в списке чатов)
#   channel-pin-1280x720.png — картинка закреп-поста: знак + имя + слоган + рубрики
# Шрифты: Jura-Medium + IBMPlexMono — единственные проверенные с настоящей кириллицей.

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

FONTS = r"C:\Users\XDot PC\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\978ac07b-90e6-4f0f-9377-9a70bf8af690\fe74928c-90de-470f-b3da-57f8c7b17749\skills\canvas-design\canvas-fonts"
OUT = r"C:\Users\XDot PC\OneDrive\Desktop\tax-navigator\brand"

SS = 4
INDIGO = (99, 102, 241)
VIOLET = (168, 85, 247)
INK = (10, 11, 20)          # фон сайта/Mini App
WIN = (52, 211, 153)

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
    """Знак «рост+стрелка» на прозрачном слое (копия из make_final.py)."""
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

def glow(size, cx, cy, radius, color, alpha):
    """Мягкое радиальное свечение — глубина как у hero__glow на лендинге."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(radius / 2))

def channel_avatar(size_out):
    """Тёмный фирменный фон + градиентная стрелка. Telegram обрежет в круг."""
    S = size_out * SS
    base = Image.new("RGBA", (S, S), INK + (255,))
    # два мягких свечения по диагонали — фон не «чёрная дыра» в тёмной теме TG
    base.alpha_composite(glow(S, int(S * 0.28), int(S * 0.30), int(S * 0.40), INDIGO, 70))
    base.alpha_composite(glow(S, int(S * 0.74), int(S * 0.72), int(S * 0.42), VIOLET, 55))
    # градиентная стрелка: белый знак как маска, сквозь неё — градиент
    mark = mark_layer(S, (255, 255, 255, 255), line_w_ratio=0.055, pad_ratio=0.28)
    grad_img = grad(S, S, INDIGO, VIOLET).convert("RGBA")
    grad_img.putalpha(mark.split()[3])
    base.alpha_composite(grad_img)
    return base.resize((size_out, size_out), Image.LANCZOS)

def pin_image(w_out=1280, h_out=720):
    """Карточка для закреп-поста: знак + имя + слоган + рубрики."""
    W, H = w_out * SS, h_out * SS
    img = Image.new("RGBA", (W, H), INK + (255,))
    img.alpha_composite(glow(W, int(W * 0.18), int(H * 0.22), int(H * 0.55), INDIGO, 60))
    img.alpha_composite(glow(W, int(W * 0.85), int(H * 0.85), int(H * 0.60), VIOLET, 45))
    d = ImageDraw.Draw(img)

    # знак-плашка слева сверху
    ic = 150 * SS
    icon_img = grad(ic, ic, INDIGO, VIOLET).convert("RGBA")
    icon_img.putalpha(squircle_mask(ic, ic, int(ic * 0.235)))
    icon_img.alpha_composite(mark_layer(ic, (255, 255, 255, 255)))
    mx = 90 * SS
    img.alpha_composite(icon_img, (mx, 78 * SS))

    f_title = font("Jura-Medium.ttf", 88)
    f_slogan = font("IBMPlexMono-Regular.ttf", 34)
    f_chip = font("IBMPlexMono-Regular.ttf", 27)

    ink = (245, 247, 255)
    mute = (160, 166, 195)

    ty = 78 * SS + ic + 52 * SS
    d.text((mx, ty), "Налоговый навигатор", font=f_title, fill=ink)
    d.text((mx + 2 * SS, ty + 118 * SS), "Налоги ИП — понятно и по делу", font=f_slogan, fill=mute)

    # рубрики-чипы внизу
    chips = ["сроки и напоминания", "выбор режима на цифрах", "реформа НДС · 2026"]
    cx = mx
    cy = H - 132 * SS
    for i, label in enumerate(chips):
        bb = d.textbbox((0, 0), label, font=f_chip)
        tw = bb[2] - bb[0]
        pad_x, pad_y = 26 * SS, 14 * SS
        box = [cx, cy, cx + tw + pad_x * 2, cy + (bb[3] - bb[1]) + pad_y * 2 + 8 * SS]
        color = WIN if i == 2 else (134, 140, 175)
        d.rounded_rectangle(box, radius=26 * SS, outline=color + (200,), width=2 * SS)
        d.text((cx + pad_x, cy + pad_y), label, font=f_chip, fill=(ink if i == 2 else mute))
        cx = box[2] + 18 * SS
    return img.resize((w_out, h_out), Image.LANCZOS)

channel_avatar(512).save(os.path.join(OUT, "channel-avatar-512.png"))
pin_image().save(os.path.join(OUT, "channel-pin-1280x720.png"))
print("OK: channel-avatar-512.png, channel-pin-1280x720.png")
