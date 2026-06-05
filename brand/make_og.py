# OG-баннер для шеринга ссылки на сайт — 1200x630, фирменный стиль.
from PIL import Image, ImageDraw, ImageFont
import os

FONTS = r"C:\Users\XDot PC\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\978ac07b-90e6-4f0f-9377-9a70bf8af690\fe74928c-90de-470f-b3da-57f8c7b17749\skills\canvas-design\canvas-fonts"
OUT = r"C:\Users\XDot PC\OneDrive\Desktop\tax-navigator\brand"
SS = 2
W, H = 1200 * SS, 630 * SS
INDIGO = (99, 102, 241); VIOLET = (168, 85, 247); GREEN = (52, 211, 153)
WHITE = (245, 247, 255); MUTE = (150, 156, 200)

def font(n, s): return ImageFont.truetype(os.path.join(FONTS, n), s * SS)
def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

# --- Фон: тёмный с радиальным свечением (низкое разрешение -> апскейл = быстро и гладко) ---
gw, gh = 300, 158
bg = Image.new("RGB", (gw, gh)); bp = bg.load()
for y in range(gh):
    for x in range(gw):
        dx, dy = (x - gw*0.80)/(gw*0.7), (y - gh*0.12)/(gh*0.75)
        glow = max(0, 1 - (dx*dx + dy*dy) ** 0.5)
        bp[x, y] = lerp((13, 15, 30), (46, 34, 78), glow * 0.95)
img = bg.resize((W, H), Image.LANCZOS)
d = ImageDraw.Draw(img)

# --- Иконка-плашка (градиент + знак «рост/стрелка») ---
ic = 150 * SS
icon = Image.new("RGB", (ic, ic), INDIGO); ip = icon.load()
for y in range(ic):
    for x in range(ic):
        ip[x, y] = lerp(INDIGO, VIOLET, ((x/ic)+(y/ic))/2)
mask = Image.new("L", (ic, ic), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, ic-1, ic-1], radius=int(ic*0.235), fill=255)
di = ImageDraw.Draw(icon)
pad = ic*0.27; x0, y0, x1, y1 = pad, pad, ic-pad, ic-pad; w = x1-x0; h = y1-y0; lw = int(ic*0.05)
pts = [(x0+0.04*w, y0+0.70*h), (x0+0.34*w, y0+0.40*h), (x0+0.54*w, y0+0.58*h), (x0+0.94*w, y0+0.12*h)]
di.line(pts, fill=(255, 255, 255), width=lw, joint="curve")
ax, ay = pts[-1]; s = 0.22*w
di.line([(ax-s, ay), (ax, ay), (ax, ay+s)], fill=(255, 255, 255), width=lw, joint="curve")
for p in [pts[0], pts[-1], (ax-s, ay), (ax, ay+s)]:
    di.ellipse([p[0]-lw//2, p[1]-lw//2, p[0]+lw//2, p[1]+lw//2], fill=(255, 255, 255))

MX = 72 * SS
img.paste(icon, (MX, 60*SS), mask)

# --- Брендовая строка справа от иконки ---
bx = MX + ic + 34*SS
d.text((bx, 74*SS), "Налоговый навигатор", font=font("Jura-Medium.ttf", 46), fill=WHITE)
d.text((bx+2*SS, 134*SS), "ИП · 2026", font=font("IBMPlexMono-Regular.ttf", 22), fill=MUTE)

# --- Большой заголовок (хук) ---
fh = font("Jura-Medium.ttf", 62)
d.text((MX, 262*SS), "Сравни 6 налоговых режимов", font=fh, fill=WHITE)
d.text((MX, 262*SS + 74*SS), "и узнай, где переплачиваешь", font=fh, fill=WHITE)
bb = d.textbbox((MX, 262*SS + 74*SS), "и узнай, где переплачиваешь", font=fh)
d.ellipse([bb[2]+12*SS, bb[3]-18*SS, bb[2]+12*SS+15*SS, bb[3]-3*SS], fill=VIOLET)

# --- Зелёный чип-акцент ---
cf = font("IBMPlexMono-Regular.ttf", 24)
chip = "С учётом реформы НДС 2026"
cb = d.textbbox((0, 0), chip, font=cf); cw, ch = cb[2]-cb[0], cb[3]-cb[1]
cx, cy = MX, 470*SS
d.rounded_rectangle([cx, cy, cx+cw+30*SS, cy+ch+24*SS], radius=int(18*SS), fill=GREEN)
d.text((cx+15*SS, cy+8*SS), chip, font=cf, fill=(8, 20, 16))

# --- Нижняя строка ---
d.text((MX, 560*SS), "@taxes_navigator_bot · бесплатный расчёт в Telegram",
       font=font("IBMPlexMono-Regular.ttf", 21), fill=MUTE)

img.resize((1200, 630), Image.LANCZOS).save(os.path.join(OUT, "og-banner-1200x630.png"))
print("done: og-banner-1200x630.png")
