#!/usr/bin/env python3
"""Generate an abstract cover for a Mercury Blog post.

    python3 make-cover.py <seed> <out.jpg> [--style rings|orbit|grid|aurora] [--tone dark|light]

The seed (use the post slug) picks colours and positions, so the same slug
always gives the same image and different posts look different. Output is
1600x900 JPEG, ~50-80 KB, in the site palette (teal, amber, violet).
Needs Pillow: pip install pillow
"""
import argparse
import hashlib
import random

from PIL import Image, ImageDraw, ImageFilter

W, H = 1600, 900
TEAL = (64, 170, 200)
CYAN = (125, 211, 224)
AMBER = (240, 178, 106)
VIOLET = (124, 92, 214)
DARK = (11, 14, 18)
LIGHT = (240, 238, 232)


def blob(img, xy, radius, color, alpha, blur):
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = xy
    d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, alpha))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('seed')
    ap.add_argument('out')
    ap.add_argument('--style', choices=['rings', 'orbit', 'grid', 'aurora', 'scopes', 'throughput', 'flow'])
    ap.add_argument('--tone', choices=['dark', 'light'])
    a = ap.parse_args()

    rnd = random.Random(int(hashlib.sha256(a.seed.encode()).hexdigest(), 16))
    style = a.style or rnd.choice(['rings', 'orbit', 'grid', 'aurora'])
    tone = a.tone or rnd.choice(['dark', 'light'])
    base = DARK if tone == 'dark' else LIGHT
    line = (255, 255, 255, 34) if tone == 'dark' else (40, 50, 60, 70)
    palette = rnd.sample([TEAL, CYAN, AMBER, VIOLET], 3)

    img = Image.new('RGBA', (W, H), (*base, 255))
    for i, c in enumerate(palette):
        blob(img, (rnd.randint(200, W - 200), rnd.randint(150, H - 150)), rnd.randint(260, 460), c, 210 - i * 40, 150)

    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    cx, cy = rnd.randint(500, 1100), rnd.randint(330, 570)
    if style == 'rings':
        for r in range(90, 900, rnd.choice([54, 70, 90])):
            d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=line, width=2)
    elif style == 'orbit':
        r = rnd.randint(220, 300)
        gap = rnd.randint(140, 220)
        for dx in (-gap // 2, gap // 2):
            d.ellipse((cx + dx - r, cy - r, cx + dx + r, cy + r), outline=line, width=2)
    elif style == 'grid':
        step = rnd.choice([60, 80, 100])
        for x in range(0, W, step):
            d.line((x, 0, x, H), fill=line, width=1)
        for y in range(0, H, step):
            d.line((0, y, W, y), fill=line, width=1)
    elif style == 'scopes':
        # Nested scope boundaries around one agent node. The outer boundary
        # has an amber approval gate on its right edge.
        acc = (*AMBER, 235)
        ax, ay = W // 2, H // 2
        for half_w, half_h in ((520, 300), (360, 200), (200, 110)):
            d.rounded_rectangle((ax - half_w, ay - half_h, ax + half_w, ay + half_h),
                                radius=38, outline=line, width=2)
        d.ellipse((ax - 26, ay - 26, ax + 26, ay + 26), fill=(*CYAN, 255))
        gx, gy = ax + 520, ay
        d.rounded_rectangle((gx - 16, gy - 46, gx + 16, gy + 46), radius=10, fill=acc)
        img.alpha_composite(overlay)
        overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
        blob(img, (gx, gy), 150, AMBER, 120, 60)
    elif style == 'throughput':
        # Bar chart: code generated (tall teal bars) vs. work shipped (short amber bars).
        # An amber verification gate sits between them.
        base_y = 780
        gate_x = 898
        blob(img, (gate_x, 420), 260, AMBER, 70, 110)
        blob(img, (480, 500), 320, TEAL, 60, 120)
        gen = [200, 262, 330, 402, 468, 540, 612, 690]
        shp = [96, 104, 118, 122, 131, 138, 142, 150]
        tops = []
        for i, h in enumerate(gen):
            x = 150 + i * 90
            d.rounded_rectangle((x, base_y - h, x + 56, base_y), radius=10,
                                fill=(*TEAL, 120), outline=(*CYAN, 255), width=3)
            tops.append((x + 28, base_y - h))
        d.line(tops, fill=(*CYAN, 255), width=3)
        for px, py in tops:
            d.ellipse((px - 7, py - 7, px + 7, py + 7), fill=(*CYAN, 255))
        tops = []
        for i, h in enumerate(shp):
            x = 960 + i * 70
            d.rounded_rectangle((x, base_y - h, x + 44, base_y), radius=8, fill=(*AMBER, 210))
            tops.append((x + 22, base_y - h))
        d.line(tops, fill=(*AMBER, 255), width=3)
        d.line((gate_x, 180, gate_x, base_y), fill=(*AMBER, 235), width=3)
        d.rounded_rectangle((gate_x - 22, 360, gate_x + 22, 440), radius=12, fill=(*AMBER, 255))
        d.line((120, base_y, 1480, base_y), fill=line, width=2)
    elif style == 'flow':
        # Many streams of generated code pass through one amber verification
        # gate; only a few reach the shipped end. The shape is the article's point.
        gx, gy = 880, H // 2
        glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)

        def curve(p0, p3, n=90):
            (x0, y0), (x3, y3) = p0, p3
            mx = (x0 + x3) / 2
            pts = []
            for k in range(n + 1):
                t = k / n
                u = 1 - t
                x = u**3 * x0 + 3 * u * u * t * mx + 3 * u * t * t * mx + t**3 * x3
                y = u**3 * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y3 + t**3 * y3
                pts.append((x, y))
            return pts

        streams = []
        for i in range(12):
            y0 = 150 + i * 50
            streams.append(curve((140, y0), (gx, gy + (y0 - gy) * 0.1)))
        shipped = []
        for ye in (330, 390, 510, 570):
            shipped.append(curve((gx, gy), (1460, ye)))

        for pts in streams:
            gd.line(pts, fill=(*TEAL, 90), width=12)
        for pts in shipped:
            gd.line(pts, fill=(*AMBER, 110), width=14)
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(7)))

        for pts in streams:
            d.line(pts, fill=(*CYAN, 170), width=2)
            d.ellipse((pts[0][0] - 6, pts[0][1] - 6, pts[0][0] + 6, pts[0][1] + 6), fill=(*CYAN, 255))
        for pts in shipped:
            d.line(pts, fill=(*AMBER, 255), width=3)
            px, py = pts[-1]
            d.ellipse((px - 11, py - 11, px + 11, py + 11), fill=(*AMBER, 255))
        for r, w in ((120, 3), (84, 2)):
            d.ellipse((gx - r, gy - r, gx + r, gy + r), outline=(*AMBER, 220), width=w)
        d.ellipse((gx - 22, gy - 22, gx + 22, gy + 22), fill=(*AMBER, 255))
        blob(img, (gx, gy), 170, AMBER, 90, 70)
    else:  # aurora: wide arcs rising from below the frame
        ay = H + rnd.randint(150, 420)
        for r in range(520, 1500, rnd.choice([48, 64])):
            d.ellipse((cx - r, ay - r, cx + r, ay + r), outline=line, width=2)

    img.alpha_composite(overlay)
    noise = Image.effect_noise((W, H), 10).convert('RGBA')
    noise.putalpha(10)
    img.alpha_composite(noise)
    img.convert('RGB').save(a.out, quality=84, optimize=True, progressive=True)
    print(f'{a.out}: {style}, {tone}')


if __name__ == '__main__':
    main()
