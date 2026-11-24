#!/usr/bin/env python3
"""Wrogie pliki dla ekstraktora OCR (fixtures/ocr/, opis w README.md). Tylko biblioteka standardowa, bez venv.

Wywołanie: python3 make-hostile.py <katalog-wyjściowy>
Powstają: petla.tiff (IFD wskazuje na siebie), heic-to-png.heic (PNG 30000 × 30000 podany jako HEIC),
pdf-wielki-obraz.pdf (obraz 40000 × 40000, 1 bit, Flate) i pdf-wspolrzedne.pdf (tekst przy x = ±5e8).
Pliki są małe: obrazy składają się z zer, więc kompresja zamienia gigabajty w kilkaset KB.
"""
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(sys.argv[1])


def tiff_loop() -> bytes:
    # little-endian classic TIFF: one 8 x 8 page whose next-IFD pointer leads back to the same IFD (offset 8)
    entries = [
        (256, 3, 1, 8), (257, 3, 1, 8), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 1),
        (273, 4, 1, 122), (277, 3, 1, 1), (278, 3, 1, 8), (279, 4, 1, 64),
    ]
    ifd = struct.pack("<H", len(entries)) + b"".join(struct.pack("<HHII", *e) for e in entries)
    ifd += struct.pack("<I", 8)  # the loop
    return b"II*\x00" + struct.pack("<I", 8) + ifd + bytes(64)


def png_bomb(width: int, height: int) -> bytes:
    # a valid PNG (1 bit, gray) of the declared size; the IDAT is a zlib stream of zeros, so the file stays small
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + bytes((width + 7) // 8)
    comp = zlib.compressobj(9)
    body = b"".join(comp.compress(row) for _ in range(height)) + comp.flush()
    ihdr = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", body) + chunk(b"IEND", b"")


def pdf(objects: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def pdf_huge_image(side: int) -> bytes:
    # one 1-bit gray image side x side, Flate-compressed in rows of zeros (black), drawn on a letter page
    row = bytes((side + 7) // 8)
    comp = zlib.compressobj(9)
    data = b"".join(comp.compress(row) for _ in range(side)) + comp.flush()
    image = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 1 "
        b"/Filter /FlateDecode /Length %d >>\nstream\n" % (side, side, len(data))
    ) + data + b"\nendstream"
    content = b"q 612 0 0 792 0 0 cm /Im1 Do Q"
    return pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
        image,
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ])


def pdf_far_text() -> bytes:
    # ordinary lines plus runs drawn at x = +5e8 and x = -5e8, far outside the page box
    lines = [
        (72, 700, "Zwykly wiersz tekstu na stronie pierwszej."),
        (500000000, 690, "Daleko w prawo od strony"),
        (-500000000, 680, "Daleko w lewo od strony"),
        (72, 660, "Drugi wiersz tekstu na tej samej stronie."),
        (72, 640, "Trzeci wiersz z liczbami 12 345,67 zl."),
    ]
    content = b"".join(b"BT /F1 12 Tf %d %d Td (%s) Tj ET\n" % (x, y, text.encode()) for x, y, text in lines)
    return pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ])


FILES = {
    "petla.tiff": tiff_loop(),
    "heic-to-png.heic": png_bomb(30000, 30000),
    "pdf-wielki-obraz.pdf": pdf_huge_image(40000),
    "pdf-wspolrzedne.pdf": pdf_far_text(),
}

for name, data in FILES.items():
    (OUT / name).write_bytes(data)
    print(f"{name}: {len(data)} B")
