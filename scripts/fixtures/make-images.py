#!/usr/bin/env python3
"""Obrazy testowe: JPG, PNG z przezroczystością, GIF, WebP, BMP, TIFF, PSD, SVG
oraz PNG, który deklaruje 50000 x 50000 pikseli (test granicy dekodera).

Wywołanie: python3 make-images.py <katalog-wyjściowy>. Wynik jest deterministyczny.
"""
import os
import struct
import sys
import zlib

import numpy as np
from PIL import Image, ImageDraw

OUT = sys.argv[1]


def path(name):
    return os.path.join(OUT, name)


def gradient(width, height):
    """Gładki gradient: mała tablica rozciągnięta do rozmiaru docelowego."""
    xs = np.linspace(40, 215, width, dtype=np.float32)
    ys = np.linspace(30, 200, height, dtype=np.float32)
    arr = np.zeros((height, width, 3), dtype=np.float32)
    arr[..., 0] = xs[None, :]
    arr[..., 1] = ys[:, None]
    arr[..., 2] = 140.0
    return Image.fromarray(arr.astype(np.uint8), "RGB")


def big_jpeg():
    # 8000 x 6000: gradient liczony w małej skali i powiększony, kilka kształtów; jakość dobrana tak,
    # by plik zmieścił się w 3 MB.
    img = gradient(400, 300).resize((8000, 6000), Image.Resampling.BICUBIC)
    draw = ImageDraw.Draw(img)
    draw.ellipse((1000, 800, 3400, 3200), fill=(235, 90, 40))
    draw.rectangle((4200, 1500, 6800, 4300), fill=(30, 120, 210))
    draw.polygon([(7000, 5600), (7900, 5600), (7450, 4700)], fill=(250, 210, 40))
    draw.ellipse((300, 4300, 1700, 5700), outline=(20, 20, 20), width=60)
    for quality in range(92, 40, -4):
        buf = path("zdjecie-8000x6000.jpg")
        img.save(buf, "JPEG", quality=quality)
        if os.path.getsize(buf) <= 3 * 1024 * 1024:
            return quality
    raise SystemExit("zdjecie-8000x6000.jpg nie mieści się w 3 MB")


def small_rgb(width=320, height=240):
    img = gradient(width, height)
    draw = ImageDraw.Draw(img)
    draw.rectangle((20, 20, 140, 110), fill=(250, 210, 40))
    draw.ellipse((180, 90, 300, 210), fill=(30, 120, 210))
    return img


def png_alpha():
    img = small_rgb().convert("RGBA")
    arr = np.array(img)
    yy, xx = np.mgrid[0:240, 0:320]
    dist = np.sqrt((xx - 160) ** 2 + (yy - 120) ** 2).astype(np.float32)
    arr[..., 3] = np.clip((120 - dist) * 4, 0, 255).astype(np.uint8)
    Image.fromarray(arr, "RGBA").save(path("obraz.png"), "PNG")


def animated_gif():
    frames = []
    for i, color in enumerate([(230, 60, 60), (60, 200, 90), (60, 110, 230)]):
        frame = Image.new("RGB", (240, 160), (245, 245, 245))
        ImageDraw.Draw(frame).rectangle((20 + i * 50, 40, 90 + i * 50, 120), fill=color)
        frames.append(frame.convert("P", palette=Image.Palette.ADAPTIVE))
    frames[0].save(path("obraz.gif"), save_all=True, append_images=frames[1:], duration=300, loop=0)


def webp_bmp_tiff():
    img = small_rgb()
    img.save(path("obraz.webp"), "WEBP", quality=80)
    img.save(path("obraz.bmp"), "BMP")
    img.save(path("obraz.tiff"), "TIFF", compression="tiff_lzw")


def packbits(row):
    """PackBits (RLE jak w PSD): ciągi powtórzeń i ciągi dosłowne, po 128 bajtów."""
    out = bytearray()
    i, n = 0, len(row)
    while i < n:
        run = 1
        while i + run < n and run < 128 and row[i + run] == row[i]:
            run += 1
        if run >= 2:
            out += bytes([257 - run, row[i]])
            i += run
            continue
        j = i
        while j < n and j - i < 128:
            if j + 1 < n and row[j] == row[j + 1]:
                break
            j += 1
        out += bytes([j - i - 1]) + row[i:j]
        i = j
    return bytes(out)


def psd():
    """Minimalny PSD wg specyfikacji Adobe: nagłówek, puste sekcje (długość 0), obraz złożony RLE, RGB 8 bitów."""
    width, height = 640, 480
    arr = np.array(gradient(width, height))
    arr[100:200, 80:300] = (250, 210, 40)
    yy, xx = np.mgrid[0:height, 0:width]
    arr[(xx - 450) ** 2 + (yy - 300) ** 2 < 120 ** 2] = (30, 120, 210)
    header = b"8BPS" + struct.pack(">H", 1) + b"\x00" * 6 + struct.pack(">HIIHH", 3, height, width, 8, 3)
    sections = struct.pack(">I", 0) + struct.pack(">I", 0) + struct.pack(">I", 0)
    rows = [[packbits(arr[y, :, c].tobytes()) for y in range(height)] for c in range(3)]
    counts = b"".join(struct.pack(">H", len(r)) for channel in rows for r in channel)
    data = struct.pack(">H", 1) + counts + b"".join(r for channel in rows for r in channel)
    with open(path("obraz.psd"), "wb") as f:
        f.write(header + sections + data)


def svg_with_script():
    body = """<?xml version="1.0" encoding="UTF-8"?>
<!-- Plik testowy: podgląd ma pokazać kod, a nie uruchomić skrypt. -->
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200" onload="alert(2)">
  <script>alert(1)</script>
  <rect x="20" y="20" width="260" height="160" rx="16" fill="#3b7dd8"/>
  <text x="150" y="110" font-size="26" text-anchor="middle" fill="#ffffff">Podgląd SVG</text>
</svg>
"""
    with open(path("skrypt.svg"), "w", encoding="utf-8") as f:
        f.write(body)


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_50000():
    """Prawdziwy nagłówek IHDR 50000 x 50000 z poprawnym CRC, potem mały IDAT i kilka KB tEXt."""
    ihdr = struct.pack(">IIBBBBB", 50000, 50000, 8, 2, 0, 0, 0)
    text = b"Comment\x00" + (b"Plik testowy: deklarowany rozmiar 50000 x 50000, dane praktycznie puste. " * 40)
    idat = zlib.compress(b"\x00" * 16)
    data = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"tEXt", text)
    data += png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")
    with open(path("obraz-50000x50000.png"), "wb") as f:
        f.write(data)


def main():
    os.makedirs(OUT, exist_ok=True)
    print("zdjecie-8000x6000.jpg quality", big_jpeg())
    png_alpha()
    animated_gif()
    webp_bmp_tiff()
    psd()
    svg_with_script()
    png_50000()


if __name__ == "__main__":
    main()
