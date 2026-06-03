# Обложка Mini App для BotFather — строго 640x360, фирменный стиль.
from PIL import Image, ImageDraw, ImageFont
import os

FONTS = r"C:\Users\XDot PC\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\978ac07b-90e6-4f0f-9377-9a70bf8af690\fe74928c-90de-470f-b3da-57f8c7b17749\skills\canvas-design\canvas-fonts"
OUT = r"C:\Users\XDot PC\OneDrive\Desktop\tax-navigator\brand"
SS = 3
W, H = 640 * SS, 360 * SS
INDIGO = (99, 102, 241); VIOLET = (168, 85, 247)

def font(n, s): return ImageFont.truetype(os.path.join(FONTS, n), s * SS)
def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

# Фон: глубокий тёмный с диагональным свечением (как сайт)
img = Image.new("RGB", (W, H), (10, 11, 20))
px = img.load()
for y in range(H):
    for x in range(W):
        # радиальное свечение из верхнего-правого угла
        dx, dy = (x - W*0.78) / (W*0.7), (y - H*0.15) / (H*0.7)
        d = (dx*dx + dy*dy) ** 0.5
        glow = max(0, 1 - d)
        base = (14, 16, 33)
        px[x, y] = lerp(base, (44, 33, 74), glow * 0.9)
d = ImageDraw.Draw(img)

# Иконка-плашка слева
ic = 150 * SS
icon = Image.new("RGB", (ic, ic), INDIGO); ip = icon.load()
for y in range(ic):
    for x in range(ic):
        ip[x, y] = lerp(INDIGO, VIOLET, ((x/ic)+(y/ic))/2)
mask = Image.new("L", (ic, ic), 0)
ImageDraw.Draw(mask).rounded_rectangle([0,0,ic-1,ic-1], radius=int(ic*0.235), fill=255)
# знак «рост+стрелка»
di = ImageDraw.Draw(icon)
pad = ic*0.27; x0,y0,x1,y1 = pad,pad,ic-pad,ic-pad; w=x1-x0; h=y1-y0; lw=int(ic*0.05)
pts=[(x0+0.04*w,y0+0.70*h),(x0+0.34*w,y0+0.40*h),(x0+0.54*w,y0+0.58*h),(x0+0.94*w,y0+0.12*h)]
di.line(pts, fill=(255,255,255), width=lw, joint="curve")
ax,ay=pts[-1]; s=0.22*w
di.line([(ax-s,ay),(ax,ay),(ax,ay+s)], fill=(255,255,255), width=lw, joint="curve")
for p in [pts[0],pts[-1],(ax-s,ay),(ax,ay+s)]:
    di.ellipse([p[0]-lw//2,p[1]-lw//2,p[0]+lw//2,p[1]+lw//2], fill=(255,255,255))
img.paste(icon, (54*SS, (H-ic)//2), mask)

# Текст справа
tx = 54*SS + ic + 40*SS
f1 = font("Jura-Medium.ttf", 50)
f2 = font("Jura-Medium.ttf", 50)
f3 = font("IBMPlexMono-Regular.ttf", 21)
d.text((tx, H/2 - 88*SS), "Налоговый", font=f1, fill=(245,247,255))
d.text((tx, H/2 - 32*SS), "навигатор", font=f2, fill=(245,247,255))
bb = d.textbbox((tx, H/2 - 32*SS), "навигатор", font=f2)
d.ellipse([bb[2]+10*SS, bb[3]-16*SS, bb[2]+10*SS+13*SS, bb[3]-3*SS], fill=VIOLET)
d.text((tx+2*SS, H/2 + 34*SS), "6 режимов · реформа НДС 2026", font=f3, fill=(150,156,200))
# чип «бесплатный расчёт»
chip = "Бесплатный расчёт за минуту"
cf = font("IBMPlexMono-Regular.ttf", 18)
cb = d.textbbox((0,0), chip, font=cf)
cw, ch = cb[2]-cb[0], cb[3]-cb[1]
cx, cy = tx+2*SS, H/2 + 72*SS
d.rounded_rectangle([cx-10*SS, cy-7*SS, cx+cw+12*SS, cy+ch+12*SS], radius=int(16*SS), fill=(52,211,153))
d.text((cx, cy), chip, font=cf, fill=(8,20,16))

img.resize((640, 360), Image.LANCZOS).save(os.path.join(OUT, "miniapp-cover-640x360.png"))
print("done: miniapp-cover-640x360.png")
