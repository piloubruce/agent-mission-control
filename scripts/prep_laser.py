#!/usr/bin/env python3
"""Prep image gravure laser pierre v4.
- Rogne cadre telephone + doigt via fraction de pixels noirs par bord.
- Grayscale contraste + denoise + nettete.
- Variantes : A grayscale (pierre claire), B inverse (ardoise),
  C seuil 1-bit, D fond blanc (flood-fill couleur jaune -> blanc, stop au chien).
"""
import os
from collections import deque
from PIL import Image, ImageFilter, ImageOps, ImageEnhance

SRC = "/home/piloubruce/.hermes/cache/images/img_823885abaaa3.jpg"
OUT = os.path.expanduser("~/images_generees")
os.makedirs(OUT, exist_ok=True)

col = Image.open(SRC).convert("RGB")
W, H = col.size
print("Source:", W, "x", H)

base = col.convert("L")
bp = base.load()

def colfrac(x):
    return sum(1 for y in range(0, H, 2) if bp[x, y] < 110) / (H // 2)
def rowfrac(y):
    return sum(1 for x in range(0, W, 2) if bp[x, y] < 110) / (W // 2)

x0 = 0
while x0 < W and colfrac(x0) > 0.6:
    x0 += 1
x1 = W - 1
while x1 > 0 and colfrac(x1) > 0.6:
    x1 -= 1
y0 = 0
while y0 < H and rowfrac(y0) > 0.6:
    y0 += 1
y1 = H - 1
while y1 > 0 and rowfrac(y1) > 0.6:
    y1 -= 1

# chasse doigt + degrade bezel residuel : coupe marge fixe bord droit/bas
x1 = int(x1 - W * 0.10)
y1 = int(y1 - H * 0.07)
x0, y0 = max(0, x0), max(0, y0)
x1, y1 = max(x0 + 30, x1), max(y0 + 30, y1)
col = col.crop((x0, y0, x1, y1))
base = base.crop((x0, y0, x1, y1))
print("Rogne ->", col.size)

W, H = col.size

# --- traitement grayscale ---
g = col.convert("L")
g = g.filter(ImageFilter.MedianFilter(5))          # denoise grain fort
g = g.filter(ImageFilter.GaussianBlur(0.6))         # lisse residu bruit
g = ImageOps.autocontrast(g, cutoff=1)
g = ImageEnhance.Contrast(g).enhance(1.3)
g = g.filter(ImageFilter.UnsharpMask(radius=2, percent=160, threshold=3))
g = ImageEnhance.Sharpness(g).enhance(1.3)

TW = 1500
if g.width > TW:
    g = g.resize((TW, int(g.height * TW / g.width)), Image.LANCZOS)
dpi = (300, 300)
W2, H2 = g.size
gp = g.load()

A = os.path.join(OUT, "A_grayscale.png"); g.save(A, dpi=dpi)
B = os.path.join(OUT, "B_inverse.png"); ImageOps.invert(g).save(B, dpi=dpi)
C = os.path.join(OUT, "C_seuil.png")
g.point(lambda v: 0 if v < 130 else 255).convert("1").save(C, dpi=dpi)

# D fond blanc : flood-fill sur couleur (jaune chaud -> blanc), s'arrete au chien
ccol = col.resize((W2, H2), Image.LANCZOS).convert("RGB")
cpix = ccol.load()
def warm(x, y):
    r, gg, b = cpix[x, y]
    return (r - b) > 35 and (r - gg) > 10 and b < 200
bg = [[False] * W2 for _ in range(H2)]
dq = deque()
for x in range(W2):
    for y in (0, H2 - 1):
        if warm(x, y):
            bg[y][x] = True; dq.append((x, y))
for y in range(H2):
    for x in (0, W2 - 1):
        if warm(x, y) and not bg[y][x]:
            bg[y][x] = True; dq.append((x, y))
while dq:
    x, y = dq.popleft()
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < W2 and 0 <= ny < H2 and not bg[ny][nx] and warm(nx, ny):
            bg[ny][nx] = True; dq.append((nx, ny))
gd = g.copy(); dp = gd.load()
for y in range(H2):
    for x in range(W2):
        if bg[y][x] or dp[x, y] > 215:
            dp[x, y] = 255
D = os.path.join(OUT, "D_fond_blanc.png"); gd.save(D, dpi=dpi)

print("Sorties:")
for p in (A, B, C, D):
    print(" -", p, Image.open(p).size)
