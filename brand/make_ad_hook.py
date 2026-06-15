# Рекламная картинка для продвижения канала @navnalog (крючок «переплата»).
# Бренд-стиль: тёмный фон + свечения + градиентное слово (как «переплачивает» на лендинге).
# 16:9 (пост/баннер) + 1:1 (квадрат под РСЯ). Шрифты Jura+IBMPlexMono — реальная кириллица.

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

FONTS = r"C:\Users\XDot PC\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\978ac07b-90e6-4f0f-9377-9a70bf8af690\fe74928c-90de-470f-b3da-57f8c7b17749\skills\canvas-design\canvas-fonts"
OUT = r"C:\Users\XDot PC\OneDrive\Desktop\tax-navigator\brand"

SS = 4
INDIGO = (99, 102, 241)
VIOLET = (168, 85, 247)
INK = (10, 11, 20)
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

def mark_layer(size, color, line_w_ratio=0.05, pad_ratio=0.26):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pad = size * pad_ratio
    x0, y0, x1, y1 = pad, pad, size - pad, size - pad
    w = x1 - x0; h = y1 - y0
    lw = int(size * line_w_ratio)
    pts = [(x0 + 0.04*w, y0 + 0.70*h), (x0 + 0.34*w, y0 + 0.40*h),
           (x0 + 0.54*w, y0 + 0.58*h), (x0 + 0.94*w, y0 + 0.12*h)]
    d.line(pts, fill=color, width=lw, joint="curve")
    ax, ay = pts[-1]; s = 0.22 * w
    d.line([(ax - s, ay), (ax, ay), (ax, ay + s)], fill=color, width=lw, joint="curve")
    rr = lw // 2
    for (px, py) in [pts[0], pts[-1], (ax - s, ay), (ax, ay + s)]:
        d.ellipse([px-rr, py-rr, px+rr, py+rr], fill=color)
    return layer

def glow(size, cx, cy, radius, color, alpha):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse([cx-radius, cy-radius, cx+radius, cy+radius], fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(radius / 2))

def brand_mark(size_px):
    """Маленькая плашка-знак (градиент + белая стрелка)."""
    ic = size_px
    icon = grad(ic, ic, INDIGO, VIOLET).convert("RGBA")
    icon.putalpha(squircle_mask(ic, ic, int(ic * 0.235)))
    icon.alpha_composite(mark_layer(ic, (255, 255, 255, 255)))
    return icon

def text_w(d, s, f):
    bb = d.textbbox((0, 0), s, font=f); return bb[2] - bb[0]

def grad_text(base, x, y, s, f):
    """Текст залит фирменным градиентом (как слово «переплачивает» на лендинге)."""
    d0 = ImageDraw.Draw(base)
    bb = d0.textbbox((0, 0), s, font=f)
    tw, th = bb[2]-bb[0], bb[3]-bb[1]
    pad = 10 * SS
    layer = Image.new("RGBA", (tw + pad*2, th + pad*2), (0,0,0,0))
    ImageDraw.Draw(layer).text((pad - bb[0], pad - bb[1]), s, font=f, fill=(255,255,255,255))
    g = grad(layer.width, layer.height, INDIGO, VIOLET).convert("RGBA")
    g.putalpha(layer.split()[3])
    base.alpha_composite(g, (int(x - pad), int(y - pad)))

def build(W_out, H_out, fname):
    W, H = W_out * SS, H_out * SS
    M = int(74 * SS)  # поле
    img = Image.new("RGBA", (W, H), INK + (255,))
    img.alpha_composite(glow(max(W, H), int(W*0.16), int(H*0.18), int(H*0.55), INDIGO, 64))
    img.alpha_composite(glow(max(W, H), int(W*0.92), int(H*0.95), int(H*0.55), VIOLET, 50))
    if img.size != (W, H):
        img = img.crop((0, 0, W, H))
    d = ImageDraw.Draw(img)

    # верх: знак + имя канала
    mk = int(58 * SS)
    img.alpha_composite(brand_mark(mk), (M, int(60 * SS)))
    f_brand = font("Jura-Medium.ttf", 30)
    d.text((M + mk + int(20*SS), int(60*SS) + (mk - 30*SS)//2 - 2*SS), "Налоговый навигатор", font=f_brand, fill=(235, 238, 250))

    # крючок — авто-подбор размера, чтобы самая длинная строка влезала по ширине поля
    max_w = W - 2*M - int(10*SS)
    big = 108
    while big > 40:
        f_hook = font("Jura-Medium.ttf", big)
        if text_w(d, "Вы переплачиваете", f_hook) <= max_w:
            break
        big -= 2
    hook_y = int((0.30 if W_out >= H_out else 0.40) * H)
    line_h = int(big * 1.06 * SS)
    d.text((M, hook_y), "Вы переплачиваете", font=f_hook, fill=(245, 247, 255))
    grad_text(img, M, hook_y + line_h, "налоги?", f_hook)

    # подзаголовок
    f_sub = font("IBMPlexMono-Regular.ttf", 29)
    sub_y = hook_y + line_h * 2 + int(28 * SS)
    d.text((M + 2*SS, sub_y), "Сравните 6 налоговых режимов ИП — на цифрах", font=f_sub, fill=(165, 171, 198))

    # низ: @navnalog слева, «Подпишитесь →» справа (бренд-пилюля)
    f_handle = font("IBMPlexMono-Regular.ttf", 28)
    by = H - int(96 * SS)
    d.text((M, by + 8*SS), "@navnalog", font=f_handle, fill=(150, 156, 180))
    f_pill = font("Jura-Medium.ttf", 30)
    label = "Подпишитесь →"
    pw = text_w(d, label, f_pill); ph = 30 * SS
    px2 = W - M; px1 = px2 - (pw + int(56*SS)); pill_y1 = by - int(6*SS); pill_y2 = pill_y1 + ph + int(34*SS)
    pill = grad(px2 - px1, pill_y2 - pill_y1, INDIGO, VIOLET).convert("RGBA")
    pill.putalpha(squircle_mask(px2 - px1, pill_y2 - pill_y1, (pill_y2 - pill_y1)//2))
    img.alpha_composite(pill, (px1, pill_y1))
    d.text((px1 + int(28*SS), pill_y1 + int(17*SS)), label, font=f_pill, fill=(255, 255, 255))

    img.resize((W_out, H_out), Image.LANCZOS).save(os.path.join(OUT, fname))

build(1280, 720, "ad-channel-hook-16x9.png")
build(1080, 1080, "ad-channel-hook-1x1.png")
print("OK: ad-channel-hook-16x9.png, ad-channel-hook-1x1.png")
