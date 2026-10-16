"""Turn the chosen raw paintings into the files the app serves.

    uv run --with pillow --with numpy python3 scripts/art/compose.py hero     # illustrations/hero-*.webp, scene-wide.webp
    uv run --with pillow --with numpy python3 scripts/art/compose.py layers   # illustrations/scene/*.webp (transparent)
    uv run --with pillow --with numpy python3 scripts/art/compose.py og       # og.jpg
    uv run --with pillow --with numpy python3 scripts/art/compose.py gifs     # gifs/*.gif
    uv run --with pillow --with numpy python3 scripts/art/compose.py all

Reads the candidates named in PICKS from /tmp/eci-art/raw (paint.py's output) and the Bricolage Grotesque
variable TTF from /tmp/eci-art/font. Only chosen, person-reviewed candidates are named here.
"""

import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW = "/tmp/eci-art/raw"
FONT = "/tmp/eci-art/font/BricolageGrotesque.ttf"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PUBLIC = os.path.join(REPO, "apps", "web", "public")

INK = (0x14, 0x1B, 0x34)
PAPER = (0xFF, 0xFF, 0xFF)
TEAL = (0x28, 0x6C, 0x71)
MARIGOLD = (0xE3, 0x9A, 0x2E)

# The candidates a person read and chose (see the report in the commit / LEDGER).
PICKS = {
    "hero-wide": "hero-wide-1.png",
    "hero-tall": "hero-tall-0.png",
    "scene-wide": "scene-wide-0.png",
    "layer-sky": "layer-sky-1.png",
    "layer-far": "layer-mid-0.png",  # the far line of palms is mid-0, shrunk and hazed (both far candidates were off),
    "layer-mid": "layer-mid-1.png",
    "layer-road": "layer-road-0.png",
    "van-side": "van-side-1.png",
    "van-break": "van-break-1.png",
    "van-night": "van-night-1.png",
    "bg-break": "bg-break-0.png",
    "bg-night": "bg-night-0.png",
}


# Paintings that came back with a soft paper border: cut this fraction off every edge.
INSET = {"hero-tall": 0.045, "bg-night": 0.04}


def raw(name):
    im = Image.open(os.path.join(RAW, PICKS[name])).convert("RGB")
    f = INSET.get(name, 0)
    if f:
        w, h = im.size
        im = im.crop((round(w * f), round(h * f), round(w * (1 - f)), round(h * (1 - f))))
    return im


def out(*parts):
    path = os.path.join(PUBLIC, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def cover(im, w, h, anchor=(0.5, 0.5)):
    """Scale to cover w×h and crop, keeping the anchor point (fractions) in view."""
    s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x = round((im.width - w) * anchor[0])
    y = round((im.height - h) * anchor[1])
    return im.crop((x, y, x + w, y + h))


def font(size, weight=700, width=100):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_axes([size if size <= 96 else 96, width, weight])  # opsz, wdth, wght
    except Exception:
        pass
    return f


# ------------------------------------------------------------------ chroma key


def keyed(name, feather=1.0):
    """Cut the flat magenta ground out of a painting. Returns RGBA with spill suppressed."""
    im = raw(name)
    a = np.asarray(im).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # magenta-ness: red and blue high, green low
    mag = np.minimum(r, b) - g
    alpha = np.clip((120 - mag) / 90.0, 0, 1)  # mag>=120 fully clear, <=30 fully opaque
    # spill: where a pixel leans magenta, pull red and blue towards green
    lean = np.clip((mag - 10) / 60.0, 0, 1) * (alpha > 0)
    r2 = r - lean * (r - g) * 0.8
    b2 = b - lean * (b - g) * 0.8
    rgba = np.stack([r2, g, b2, alpha * 255], axis=-1).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    if feather:
        al = img.getchannel("A").filter(ImageFilter.GaussianBlur(feather))
        img.putalpha(al)
    return img


def tight(img, pad=4):
    bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    return img.crop((max(0, x0 - pad), max(0, y0 - pad), min(img.width, x1 + pad), min(img.height, y1 + pad)))


# ------------------------------------------------------------------ hero + scene


def hero():
    wide = cover(raw("hero-wide"), 1600, 900)
    wide.save(out("illustrations", "hero-wide.webp"), "WEBP", quality=80, method=6)
    tall = cover(raw("hero-tall"), 900, 1200)
    tall.save(out("illustrations", "hero-tall.webp"), "WEBP", quality=80, method=6)
    scene = cover(raw("scene-wide"), 1920, 1080)
    scene.save(out("illustrations", "scene-wide.webp"), "WEBP", quality=72, method=6)


def far_layer(W, H):
    """Distant palms and sea: the spare mid sheet, shrunk small, pushed back into the haze, over a sea band."""
    haze = np.array([238, 212, 190], dtype=np.float32)  # dusty apricot, the sky near the horizon
    palms = tight(keyed("layer-far"))
    s = (H * 0.21) / palms.height
    palms = palms.resize((round(palms.width * s), round(palms.height * s)), Image.LANCZOS)
    a = np.asarray(palms).astype(np.float32)
    a[..., :3] = a[..., :3] * 0.3 + haze * 0.7
    a[..., 3] *= 0.92
    palms = Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")
    horizon = round(H * 0.6)
    far = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    # sea: a band cut from the calm scene painting, faded in at the top
    scene = raw("scene-wide")
    sw, sh = scene.size
    band = scene.crop((round(sw * 0.15), round(sh * 0.655), round(sw * 0.42), round(sh * 0.70)))
    band = band.resize((W, round(H * 0.1)), Image.LANCZOS).convert("RGBA")
    ba = np.asarray(band).astype(np.float32)
    k = 10
    ba[:k, :, 3] = (ba[:k, :, 3].T * np.linspace(0, 1, k)).T
    far.alpha_composite(loopable(Image.fromarray(ba.clip(0, 255).astype(np.uint8), "RGBA"), 0.2), (0, horizon - 4))
    # the palm line, tiled across with a little overlap, flipped every other tile so it reads less repeated
    x = -round(palms.width * 0.1)
    flip = False
    while x < W:
        tile = palms.transpose(Image.FLIP_LEFT_RIGHT) if flip else palms
        far.alpha_composite(tile, (x, horizon - palms.height + round(H * 0.02)))
        x += round(palms.width * 0.9)
        flip = not flip
    return loopable(far, 0.08)


def layers():
    W, H = 1920, 1080
    cover(raw("layer-sky"), W, H).save(out("illustrations", "scene", "sky.webp"), "WEBP", quality=72, method=6)
    far_layer(W, H).save(out("illustrations", "scene", "far.webp"), "WEBP", quality=72, method=6)
    for name, fname in (("layer-mid", "mid.webp"), ("layer-road", "road.webp")):
        img = loopable(keyed(name).resize((W, H), Image.LANCZOS))
        img.save(out("illustrations", "scene", fname), "WEBP", quality=72, method=6)
    van = tight(keyed("van-side"))
    van.thumbnail((900, 600), Image.LANCZOS)
    van.save(out("illustrations", "scene", "van.webp"), "WEBP", quality=85, method=6)
    # a flattened preview of the stack, to look at (and for the report); not served
    stack = cover(raw("layer-sky"), W, H).convert("RGBA")
    for fname in ("far.webp", "mid.webp", "road.webp"):
        stack.alpha_composite(Image.open(out("illustrations", "scene", fname)).convert("RGBA"))
    stack.alpha_composite(van, (W - van.width - 160, H - van.height - 70))
    stack.convert("RGB").save("/tmp/eci-art/scene-stack-preview.jpg", quality=80)


def loopable(img, frac=0.08):
    """Crossfade the left edge over the right edge so the layer tiles horizontally without a seam.
    The result keeps the input size (the blended strip is stretched back out, a few percent)."""
    w, h = img.size
    n = int(w * frac)
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    outp = a[:, : w - n].copy()
    ramp = np.linspace(0, 1, n)[None, :, None]
    outp[:, :n] = a[:, :n] * ramp + a[:, w - n :] * (1 - ramp)
    return Image.fromarray(outp.clip(0, 255).astype(np.uint8), "RGBA").resize((w, h), Image.LANCZOS)


# ------------------------------------------------------------------ OG card


def text_block(draw, xy, lines, fill, stroke=None):
    x, y = xy
    for text, f, gap in lines:
        if stroke:
            draw.text((x, y), text, font=f, fill=fill, stroke_width=stroke[1], stroke_fill=stroke[0])
        else:
            draw.text((x, y), text, font=f, fill=fill)
        y += f.getbbox(text)[3] + gap
    return y


def arrow(d, x, y, w, fill, width=4):
    """A hand-set double arrow (the font has no U+2194)."""
    h = width * 2.2
    d.line((x, y, x + w, y), fill=fill, width=width)
    d.line((x + h, y - h, x, y, x + h, y + h), fill=fill, width=width, joint="curve")
    d.line((x + w - h, y - h, x + w, y, x + w - h, y + h), fill=fill, width=width, joint="curve")


def og():
    W, H = 1200, 630
    im = cover(raw("hero-wide"), W, H, anchor=(0.55, 0.5)).convert("RGBA")
    # a soft paper wash top-left so the title reads at thumbnail size
    wash = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wash)
    for i in range(70):
        a = int(235 * (1 - i / 70) ** 1.2)
        wd.rounded_rectangle((-200, -200, 640 + i * 10, 360 + i * 6), radius=200, fill=PAPER + (a,))
    wash = wash.filter(ImageFilter.GaussianBlur(40))
    im = Image.alpha_composite(im, wash)
    d = ImageDraw.Draw(im)
    title = font(96, 800)
    sub = font(34, 600)
    tag = font(26, 700)
    y = text_block(d, (56, 64), [("Where's the", title, -8), ("shuttle?", title, 20)], INK)
    sy = y + 8
    x = 58
    d.text((x, sy), "Live Riva", font=sub, fill=TEAL)
    x += d.textlength("Live Riva ", font=sub)
    arrow(d, x + 2, sy + 22, 38, TEAL)
    x += 52
    d.text((x, sy), "Circle shuttle", font=sub, fill=TEAL)
    # a marigold pill for the event name
    label = "EDGE CITY INDIA 2026"
    tw = d.textlength(label, font=tag)
    px, py = 58, sy + 62
    d.rounded_rectangle((px, py, px + tw + 36, py + 46), radius=23, fill=MARIGOLD)
    d.text((px + 18, py + 9), label, font=tag, fill=PAPER)
    path = out("og.jpg")
    q = 86
    while True:
        im.convert("RGB").save(path, "JPEG", quality=q, optimize=True, progressive=True)
        if os.path.getsize(path) < 290_000 or q <= 50:
            break
        q -= 6


# ------------------------------------------------------------------ GIFs

GW, GH = 480, 270
FPS = 10


def paste(base, layer, x, y):
    base.alpha_composite(layer, (int(x), int(y)))


def save_gif(frames, name, colors=96, fps=FPS):
    """Quantize every frame to one shared adaptive palette (steady colours, no flicker) and loop."""
    sheet = Image.new("RGB", (frames[0].width, frames[0].height * min(len(frames), 6)))
    step = max(1, len(frames) // 6)
    for i, f in enumerate(frames[::step][:6]):
        sheet.paste(f.convert("RGB"), (0, i * frames[0].height))
    pal = sheet.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    # no dither: dithering noise defeats GIF compression, and the gouache quantizes cleanly
    q = [f.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    path = out("gifs", name)
    q[0].save(path, save_all=True, append_images=q[1:], duration=int(1000 / fps), loop=0, optimize=True, disposal=1)
    size = os.path.getsize(path)
    print(name, len(frames), "frames", size // 1024, "KB")
    return size


def van_sprite(name, width):
    v = tight(keyed(name))
    s = width / v.width
    return v.resize((width, round(v.height * s)), Image.LANCZOS)


def bob(t, amp=2.2, freq=2.0, phase=0.0):
    return amp * math.sin(2 * math.pi * freq * t + phase)


def scene_layers():
    sky = cover(raw("layer-sky"), GW, GH).convert("RGBA")
    far = far_layer(GW * 2, GH * 2).resize((GW, GH), Image.LANCZOS)
    mid = loopable(keyed("layer-mid").resize((GW * 2, GH * 2), Image.LANCZOS)).resize((GW, GH), Image.LANCZOS)
    road = loopable(keyed("layer-road").resize((GW * 2, GH * 2), Image.LANCZOS)).resize((GW, GH), Image.LANCZOS)
    return sky, far, mid, road


def scroll(base, layer, offset):
    """Tile a loopable layer horizontally at an x offset (positive = scene moves left)."""
    w = layer.width
    off = int(offset) % w
    paste(base, layer, -off, 0)
    paste(base, layer, w - off, 0)


def gif_on_the_way(seconds=2.25, fps=8):
    """Every frame of a scrolling scene is new pixels, so this one runs at 8 fps and a short loop to fit 900 KB."""
    sky, far, mid, road = scene_layers()
    van = van_sprite("van-side", 215)
    n = int(seconds * fps)
    frames = []
    for i in range(n):
        t = i / fps
        f = sky.copy()
        paste(f, far, 0, 0)  # the far palms barely move
        scroll(f, mid, (t / seconds) * mid.width * 1)
        scroll(f, road, (t / seconds) * road.width * 2)
        vy = GH - van.height - 18 + bob(t, 2.0, 3.0)
        paste(f, van, 118, vy)
        # little dust puffs behind the back wheel
        d = ImageDraw.Draw(f)
        for k in range(3):
            ph = (t / seconds * 4 + k / 3) % 1.0
            px = 118 + van.width - 10 + ph * 46
            py = GH - 26 - ph * 14
            rr = 3 + ph * 6
            a = int(150 * (1 - ph))
            d.ellipse((px - rr, py - rr, px + rr, py + rr), fill=(214, 170, 130, a // 2))
        frames.append(f)
    save_gif(frames, "on-the-way.gif", colors=64, fps=fps)


def confetti(seed=7, count=36):
    rnd = random.Random(seed)
    cols = [MARIGOLD, TEAL, (0xE0, 0x5C, 0x5C), (0xF3, 0xD2, 0x6B), (0x7F, 0xB5, 0x6E)]
    return [
        (rnd.random(), rnd.random(), rnd.choice(cols), rnd.choice([1, 1, 2]), rnd.random() * 6.28, rnd.choice([4, 5, 6]))
        for _ in range(count)
    ]


def gif_welcome(seconds=3.0):
    sky, far, mid, road = scene_layers()
    van = van_sprite("van-side", 230)
    pieces = confetti()
    n = int(seconds * FPS)
    frames = []
    for i in range(n):
        t = i / FPS
        f = sky.copy()
        paste(f, far, 0, 0)
        paste(f, mid, 0, 0)
        paste(f, road, 0, 0)
        d = ImageDraw.Draw(f)
        # confetti drifting down, looping
        for x0, y0, col, speed, ph, sz in pieces:
            u = (y0 + t * speed / seconds) % 1.0
            x = x0 * GW + 10 * math.sin(2 * math.pi * (t / seconds) + ph)
            y = u * (GH + 20) - 10
            ang = ph + 2 * math.pi * 2 * t / seconds
            dx, dy = sz * math.cos(ang), sz * math.sin(ang)
            d.line((x - dx, y - dy, x + dx, y + dy), fill=col + (235,), width=sz)
        # van: a gentle "honk" bounce twice per loop
        hop = max(0.0, math.sin(2 * math.pi * 2 * t / seconds))
        vy = GH - van.height - 18 - hop * 7
        paste(f, van, 125, vy)
        # honk arcs off the front (left) of the van
        k = int((t / seconds * 6) % 3)
        cx, cy = 125 - 4, vy + van.height * 0.5
        for j in range(k + 1):
            rr = 12 + j * 11
            a = int(240 - j * 50)
            d.arc((cx - rr, cy - rr, cx + rr, cy + rr), 140, 220, fill=INK + (a,), width=5)
        frames.append(f)
    save_gif(frames, "welcome.gif")


def steam(d, x, y, t, seconds, seed=3, n=4):
    rnd = random.Random(seed)
    for k in range(n):
        ph = (t / seconds * 2 + k / n) % 1.0
        wob = rnd.uniform(4, 9)
        px = x + wob * math.sin(ph * 6.28 + k)
        py = y - ph * 34
        rr = 2.5 + ph * 5
        a = int(200 * (1 - ph) ** 1.2)
        d.ellipse((px - rr, py - rr, px + rr, py + rr), fill=(255, 250, 240, a))


def gif_break(seconds=3.0):
    bg = cover(raw("bg-break"), GW, GH).convert("RGBA")
    van = van_sprite("van-break", 225)
    n = int(seconds * FPS)
    frames = []
    vx, vy = 215, GH - van.height - 16
    for i in range(n):
        t = i / FPS
        f = bg.copy()
        # a slow breath on the parked van
        s = 1 + 0.006 * math.sin(2 * math.pi * t / seconds)
        v = van.resize((round(van.width * s), round(van.height * s)), Image.LANCZOS)
        paste(f, v, vx - (v.width - van.width) / 2, vy - (v.height - van.height))
        d = ImageDraw.Draw(f)
        steam(d, vx + van.width * 0.34, vy + van.height * 0.40, t, seconds)
        # Z z z drifting up from the driver's window
        for k in range(3):
            ph = (t / seconds + k / 3) % 1.0
            zx = vx + van.width * 0.26 + ph * 16 + 6 * math.sin(ph * 6)
            zy = vy + van.height * 0.22 - ph * 46
            zs = 10 + int(ph * 10)
            a = int(255 * (1 - ph) ** 1.5)
            d.text((zx, zy), "z", font=font(zs, 800), fill=INK + (a,))
        frames.append(f)
    save_gif(frames, "break.gif")


def gif_goodnight(seconds=3.0):
    bg = cover(raw("bg-night"), GW, GH).convert("RGBA")
    van = van_sprite("van-night", 220)
    rnd = random.Random(11)
    stars = [(rnd.random() * GW, rnd.random() * GH * 0.45, rnd.random() * 6.28, rnd.uniform(1.2, 2.4)) for _ in range(22)]
    n = int(seconds * FPS)
    frames = []
    vx, vy = 150, GH - van.height - 14
    for i in range(n):
        t = i / FPS
        f = bg.copy()
        d = ImageDraw.Draw(f)
        for sx, sy, ph, sz in stars:
            tw = 0.5 + 0.5 * math.sin(2 * math.pi * t / seconds * 2 + ph)
            a = int(60 + 190 * tw)
            r = sz * (0.7 + 0.5 * tw)
            d.ellipse((sx - r, sy - r, sx + r, sy + r), fill=(255, 244, 200, a))
        paste(f, van, vx, vy)
        for k in range(3):
            ph = (t / seconds + k / 3) % 1.0
            zx = vx + van.width * 0.5 + ph * 22 + 5 * math.sin(ph * 6)
            zy = vy - 4 - ph * 52
            zs = 11 + int(ph * 12)
            a = int(255 * (1 - ph) ** 1.5)
            d.text((zx, zy), "z", font=font(zs, 800), fill=(255, 244, 200, a))
        frames.append(f)
    save_gif(frames, "goodnight.gif")


def gifs():
    gif_welcome()
    gif_on_the_way()
    gif_break()
    gif_goodnight()


if __name__ == "__main__":
    steps = {"hero": hero, "layers": layers, "og": og, "gifs": gifs}
    which = sys.argv[1:] or ["all"]
    for w in which:
        if w == "all":
            for fn in steps.values():
                fn()
        else:
            steps[w]()
