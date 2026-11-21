#!/usr/bin/env python3
"""Generate the ScreenGrab PNG app icons (no third-party dependencies)."""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")


def clamp(v, a=0.0, b=1.0):
    return a if v < a else b if v > b else v


def mix(a, b, t):
    t = clamp(t)
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def sd_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def render(size, maskable=False):
    scale = 0.8 if maskable else 1.0
    aa = 1.15 / (size * scale)
    buf = bytearray(size * size * 4)

    # screen geometry (normalised design space)
    scx, scy, shw, shh, sr = 0.5, 0.5, 0.27, 0.155, 0.045
    stroke = 0.026
    inner = 0.032

    # crop brackets
    bx0, bx1, by0, by1 = 0.135, 0.865, 0.255, 0.745
    arm, th = 0.095, 0.024

    # chart bars inside the screen
    bars = [
        (0.05, 0.042, 0.0),
        (0.085, 0.042, 0.062),
        (0.065, 0.042, 0.124),
        (0.115, 0.042, 0.186),
    ]
    bar_base = scy + shh - 0.036

    for y in range(size):
        for x in range(size):
            dx = (x + 0.5) / size
            dy = (y + 0.5) / size
            u = 0.5 + (dx - 0.5) / scale
            v = 0.5 + (dy - 0.5) / scale

            # background: deep navy with a soft diagonal light
            t = clamp(u * 0.35 + v * 0.75)
            r, g, b = mix((10, 17, 24), (4, 7, 11), t)
            glow = math.exp(-(((u - 0.38) ** 2 + (v - 0.3) ** 2) / 0.09))
            r += 12 * glow
            g += 34 * glow
            b += 36 * glow

            d_screen = sd_round_rect(u, v, scx, scy, shw, shh, sr)

            # halo around the screen
            halo = math.exp(-((max(d_screen, 0.0) / 0.085) ** 2)) * 0.30
            r += 10 * halo
            g += 52 * halo
            b += 48 * halo

            # screen body
            fill_cov = clamp(0.5 - d_screen / aa)
            if fill_cov > 0:
                ft = clamp((v - (scy - shh)) / (shh * 2))
                fr, fg, fb = mix((13, 31, 43), (6, 14, 21), ft)
                r += (fr - r) * fill_cov
                g += (fg - g) * fill_cov
                b += (fb - b) * fill_cov

                # content: title bar
                if abs(v - (scy - shh + 0.045)) < 0.0075 and abs(u - (scx - shw + 0.072)) < 0.052:
                    ct = clamp(1.0 - abs(v - (scy - shh + 0.045)) / 0.0075)
                    r += (190 - r) * ct * 0.85
                    g += (255 - g) * ct * 0.85
                    b += (250 - b) * ct * 0.85

                # content: live dot
                d_dot = sd_circle(u, v, scx + shw - 0.055, scy - shh + 0.045, 0.014)
                dot_cov = clamp(0.5 - d_dot / aa)
                if dot_cov > 0:
                    r += (45 - r) * dot_cov
                    g += (212 - g) * dot_cov
                    b += (191 - b) * dot_cov

                # content: chart bars
                for bh, bw, off in bars:
                    cx = scx - 0.115 + off + bw / 2
                    cy = bar_base - bh / 2
                    d_bar = sd_round_rect(u, v, cx, cy, bw / 2, bh / 2, min(bw, bh) * 0.28)
                    cov = clamp(0.5 - d_bar / aa)
                    if cov > 0:
                        bt = clamp((v - (bar_base - bh)) / max(bh, 1e-6))
                        br, bg, bb = mix((94, 234, 212), (34, 211, 238), bt)
                        r += (br - r) * cov
                        g += (bg - g) * cov
                        b += (bb - b) * cov

            # screen stroke
            stroke_cov = clamp((stroke / 2 + aa / 2 - abs(d_screen)) / aa)
            if stroke_cov > 0:
                st = clamp((u - (scx - shw)) / (shw * 2))
                sr_, sg_, sb_ = mix((110, 245, 226), (34, 211, 238), st)
                r += (sr_ - r) * stroke_cov
                g += (sg_ - g) * stroke_cov
                b += (sb_ - b) * stroke_cov

            # crop brackets (four L shapes)
            bd = 1.0
            for (hx0, hx1, vy) in (
                (bx0, bx0 + arm, by0),
                (bx1 - arm, bx1, by0),
                (bx0, bx0 + arm, by1),
                (bx1 - arm, bx1, by1),
            ):
                bd = min(bd, sd_round_rect(u, v, (hx0 + hx1) / 2, vy, (hx1 - hx0) / 2, th / 2, th / 2))
            for (vx, hy0, hy1) in (
                (bx0, by0, by0 + arm),
                (bx1, by0, by0 + arm),
                (bx0, by1 - arm, by1),
                (bx1, by1 - arm, by1),
            ):
                bd = min(bd, sd_round_rect(u, v, vx, (hy0 + hy1) / 2, th / 2, (hy1 - hy0) / 2, th / 2))

            b_cov = clamp(0.5 - bd / aa) * 0.92
            if b_cov > 0:
                r += (236 - r) * b_cov
                g += (255 - g) * b_cov
                b += (251 - b) * b_cov

            i = (y * size + x) * 4
            buf[i] = int(clamp(r, 0, 255))
            buf[i + 1] = int(clamp(g, 0, 255))
            buf[i + 2] = int(clamp(b, 0, 255))
            buf[i + 3] = 255
    return buf


def write_png(path, size, buf):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(buf[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-512.png", 512, False),
        ("icon-192.png", 192, False),
        ("apple-touch-icon.png", 180, False),
        ("maskable-512.png", 512, True),
        ("maskable-192.png", 192, True),
    ]
    for name, size, maskable in jobs:
        buf = render(size, maskable)
        write_png(os.path.join(OUT, name), size, buf)
        print("wrote", name)


if __name__ == "__main__":
    main()
