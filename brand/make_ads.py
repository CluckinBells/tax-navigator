# Рекламные баннеры для Яндекс.Директ — фирменный стиль, точные пропорции.
# Форматы: 1:1 (1080x1080), 16:9 (1920x1080), 3:4 (1080x1440).
from PIL import Image, ImageDraw, ImageFont
import os

FONTS = r"C:\Users\XDot PC\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\978ac07b-90e6-4f0f-9377-9a70bf8af690\fe74928c-90de-470f-b3da-57f8c7b17749\skills\canvas-design\canvas-fonts"
OUT = r"C:\Users\XDot PC\OneDrive\Desktop\tax-navigator\brand"
SS = 2
INDIGO = (99, 102, 241); VIOLET = (168, 85, 247); GREEN = (52, 211, 153)
WHITE = (245, 247, 255); MUTE = (150, 156, 200)
JURA = "Jura-Medium.ttf"; MONO = "IBMPlexMono-Regular.ttf"


def font(n, s): return ImageFont.truetype(os.path.join(FONTS, n), int(s * SS))
def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))


def make_bg(W, H, gx=0.80, gy=0.12):
    """Тёмный фон с радиальным свечением (рисуем мелким -> апскейл = гладко и быстро)."""
    gw, gh = 300, int(300 * H / W)
    bg = Image.new("RGB", (gw, gh)); bp = bg.load()
    for y in range(gh):
        for x in range(gw):
            dx, dy = (x - gw*gx)/(gw*0.7), (y - gh*gy)/(gh*0.75)
            glow = max(0, 1 - (dx*dx + dy*dy) ** 0.5)
            bp[x, y] = lerp((13, 15, 30), (46, 34, 78), glow * 0.95)
    return bg.resize((W, H), Image.LANCZOS)


def make_icon(ic):
    """Иконка-плашка: градиент indigo->violet + знак рост/стрелка."""
    icon = Image.new("RGB", (ic, ic), INDIGO); ip = icon.load()
    for y in range(ic):
        for x in range(ic):
            ip[x, y] = lerp(INDIGO, VIOLET, ((x/ic)+(y/ic))/2)
    mask = Image.new("L", (ic, ic), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, ic-1, ic-1], radius=int(ic*0.235), fill=255)
    di = ImageDraw.Draw(icon)
    pad = ic*0.27; x0, y0, x1, y1 = pad, pad, ic-pad, ic-pad; w = x1-x0; h = y1-y0; lw = max(2, int(ic*0.05))
    pts = [(x0+0.04*w, y0+0.70*h), (x0+0.34*w, y0+0.40*h), (x0+0.54*w, y0+0.58*h), (x0+0.94*w, y0+0.12*h)]
    di.line(pts, fill=(255, 255, 255), width=lw, joint="curve")
    ax, ay = pts[-1]; s = 0.22*w
    di.line([(ax-s, ay), (ax, ay), (ax, ay+s)], fill=(255, 255, 255), width=lw, joint="curve")
    for p in [pts[0], pts[-1], (ax-s, ay), (ax, ay+s)]:
        di.ellipse([p[0]-lw//2, p[1]-lw//2, p[0]+lw//2, p[1]+lw//2], fill=(255, 255, 255))
    return icon, mask


def chip(d, x, y, text, f, fg=(8, 20, 16), bg=GREEN, padx=16, pady=11):
    cb = d.textbbox((0, 0), text, font=f); cw, ch = cb[2]-cb[0], cb[3]-cb[1]
    d.rounded_rectangle([x, y, x+cw+padx*2*SS, y+ch+pady*2*SS], radius=int(16*SS), fill=bg)
    d.text((x+padx*SS, y+pady*SS-cb[1]), text, font=f, fill=fg)
    return cw+padx*2*SS, ch+pady*2*SS


def render(name, Wl, Hl, layout):
    W, H = Wl*SS, Hl*SS
    img = make_bg(W, H); d = ImageDraw.Draw(img)
    layout(img, d, W, H)
    img.resize((Wl, Hl), Image.LANCZOS).save(os.path.join(OUT, name))
    print("done:", name)


def brand_lockup(img, d, x, y, ic, name_sz, sub_sz, gap=30):
    icon, mask = make_icon(ic); img.paste(icon, (x, y), mask)
    bx = x + ic + int(gap*SS)
    fn = font(JURA, name_sz)
    nb = d.textbbox((0, 0), "Налоговый навигатор", font=fn)
    nh = nb[3]-nb[1]
    fs = font(MONO, sub_sz)
    sb = d.textbbox((0, 0), "ИП · 2026", font=fs); sh = sb[3]-sb[1]
    total = nh + int(14*SS) + sh
    ty = y + (ic - total)//2
    d.text((bx, ty - nb[1]), "Налоговый навигатор", font=fn, fill=WHITE)
    d.text((bx, ty + nh + int(14*SS) - sb[1]), "ИП · 2026", font=fs, fill=MUTE)


# ---------- 1:1 (1080x1080) ----------
def layout_square(img, d, W, H):
    M = int(96*SS)
    brand_lockup(img, d, M, int(96*SS), int(150*SS), 42, 22)
    fh = font(JURA, 92)
    lines = ["Какой налоговый", "режим выбрать ИП?"]
    y = int(400*SS)
    for ln in lines:
        d.text((M, y), ln, font=fh, fill=WHITE); y += int(104*SS)
    # фиолетовая точка-акцент в конце вопроса
    bb = d.textbbox((M, y-int(104*SS)), lines[-1], font=fh)
    d.ellipse([bb[2]+int(14*SS), bb[3]-int(24*SS), bb[2]+int(14*SS)+int(18*SS), bb[3]-int(6*SS)], fill=VIOLET)
    chip(d, M, int(690*SS), "Сравни 6 режимов · НДС-реформа 2026", font(MONO, 28))
    d.text((M, int(820*SS)), "Бесплатный расчёт в Telegram", font=font(JURA, 40), fill=WHITE)
    d.text((M, int(885*SS)), "@taxes_navigator_bot · navnalog.ru", font=font(MONO, 24), fill=MUTE)


# ---------- 16:9 (1920x1080) ----------
def layout_wide(img, d, W, H):
    M = int(110*SS)
    brand_lockup(img, d, M, int(110*SS), int(168*SS), 56, 28)
    fh = font(JURA, 104)
    lines = ["Сравни 6 налоговых режимов", "и узнай, где переплачиваешь"]
    y = int(420*SS)
    for ln in lines:
        d.text((M, y), ln, font=fh, fill=WHITE); y += int(120*SS)
    bb = d.textbbox((M, y-int(120*SS)), lines[-1], font=fh)
    d.ellipse([bb[2]+int(16*SS), bb[3]-int(28*SS), bb[2]+int(16*SS)+int(20*SS), bb[3]-int(8*SS)], fill=VIOLET)
    chip(d, M, int(760*SS), "С учётом реформы НДС 2026 · бесплатно", font(MONO, 32))
    d.text((M, int(905*SS)), "@taxes_navigator_bot · расчёт в Telegram",
           font=font(MONO, 28), fill=MUTE)


# ---------- 3:4 (1080x1440) ----------
def layout_tall(img, d, W, H):
    M = int(96*SS)
    brand_lockup(img, d, M, int(120*SS), int(156*SS), 44, 22)
    fh = font(JURA, 90)
    lines = ["Какой режим", "выбрать ИП", "в 2026 году?"]
    y = int(460*SS)
    for ln in lines:
        d.text((M, y), ln, font=fh, fill=WHITE); y += int(102*SS)
    bb = d.textbbox((M, y-int(102*SS)), lines[-1], font=fh)
    d.ellipse([bb[2]+int(14*SS), bb[3]-int(24*SS), bb[2]+int(14*SS)+int(18*SS), bb[3]-int(6*SS)], fill=VIOLET)
    chip(d, M, int(880*SS), "6 режимов · реформа НДС 2026", font(MONO, 28))
    d.text((M, int(1090*SS)), "Сравни и не переплачивай", font=font(JURA, 46), fill=WHITE)
    chip(d, M, int(1180*SS), "Бесплатно", font(MONO, 26), bg=INDIGO, fg=WHITE)
    d.text((M, int(1300*SS)), "@taxes_navigator_bot", font=font(MONO, 26), fill=MUTE)


render("ad-square-1080.png", 1080, 1080, layout_square)
render("ad-wide-1920x1080.png", 1920, 1080, layout_wide)
render("ad-tall-1080x1440.png", 1080, 1440, layout_tall)
print("ALL DONE")
