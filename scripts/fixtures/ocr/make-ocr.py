#!/usr/bin/env python3
"""Zestaw testowy OCR (fixtures/ocr/): PDF z tekstem, skany, mieszany, hasło, zły font, obrazy po polsku,
EXIF, TIFF, HEIC, obraz ogromny, plik obcięty i losowe bajty. Wszystko od zera i deterministycznie
(ziarna losowe, stałe daty i ID w PDF). Obok każdego pliku powstaje <nazwa>.expected.txt; strony są
oddzielone linią \\f.

Wywołanie: python3 make-ocr.py <katalog-roboczy> <katalog-wyjściowy> <katalog-czcionek-liberation>
Wymaga: Pillow, fontTools, pypdf, cryptography, pillow-heif (make-ocr-fixtures.sh tworzy venv z przypiętymi
wersjami), soffice w PATH. Czcionka: LiberationSans-Regular.ttf (OFL). Nic nie jest pobierane.
"""
import hashlib
import io
import random
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path
from xml.sax.saxutils import escape

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject
import pillow_heif

WORK = Path(sys.argv[1])
OUT = Path(sys.argv[2])
REG = Path(sys.argv[3]) / "LiberationSans-Regular.ttf"
DATE = "D:20260101000000Z"
PRODUCER = "make-ocr.py"
HASLO = "test-haslo-ocr"  # hasło testowe, nie tajemnica
WLASCICIEL = "wlasciciel-testowy"

# Tekst z make_images.py (job cee8099b): faktura, stopka, zdania z polskimi znakami
LINES = [
    "FAKTURA VAT nr 12/03/2026",
    "Sprzedawca: Przedsiębiorstwo Usługowe Żółw sp. z o.o.",
    "ul. Źródlana 15, 00-950 Łódź",
    "Nabywca: Gęślą Jaźń Spółdzielnia Mieszkaniowa",
    "Termin płatności: 15 marca 2026 r.",
    "Usługa hostingu serwera — 1 240,00 zł",
    "Zażółć gęślą jaźń. Pchnąć w tę łódź jeża",
    "lub ośm skrzyń fig. Ćma ślizga się po żółtym liściu.",
    "Razem do zapłaty: 1 525,20 zł (słownie: tysiąc pięćset",
    "dwadzieścia pięć złotych 20/100)",
    "Uwagi: płatność przelewem na rachunek 12 3456 7890",
    "Dziękujemy za współpracę i życzymy miłego dnia!",
]
COLUMNS = [
    ["Pierwsza kolumna tekstu", "zawiera zdania o pogodzie,", "która w środę będzie", "słoneczna i ciepła."],
    ["Druga kolumna opisuje", "wyniki sprzedaży w maju:", "wzrost o 12,5 procent", "względem kwietnia."],
]
# Drugi tekst (list), na stronach skanów i w TIFF
LETTER = [
    "Szanowni Państwo,",
    "w załączeniu przesyłamy zestawienie rozliczeń za kwartał.",
    "Prosimy o sprawdzenie danych i zgłoszenie uwag do końca miesiąca.",
    "Sprawy sporne proszę kierować do pokoju 214, Dział Rozliczeń.",
    "Łączna kwota: 12 345,67 zł; zaliczka: 2 000,00 zł.",
    "Pozdrawiamy serdecznie.",
]
HEIC_LINES = [
    "Zdjęcie strony z telefonu",
    "Zażółć gęślą jaźń: ą ć ę ł ń ó ś ź ż.",
    "Ćma, ślimak i żaba siedzą na łące.",
    "Pchnąć w tę łódź jeża lub ośm skrzyń fig.",
]
TITLE1 = "Dokument testowy OCR: PDF z warstwą tekstu"
TITLE2 = "Strona 2: dwie kolumny"
BIG_LINE = "Krótki wiersz na bardzo dużym obrazie."


def expected(name, *pages):
    """Plik <name>.expected.txt: linie stron, strony oddzielone linią \\f. Brak stron = pusty plik."""
    text = "\n\f\n".join("\n".join(p) for p in pages)
    (OUT / f"{name}.expected.txt").write_text(text + "\n" if text else "", encoding="utf-8")


# ---------- obrazy ----------

def draw_page(lines, size, font_px, x, y0, gap=1.8):
    img = Image.new("L", size, 255)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(REG), font_px)
    y = y0
    for line in lines:
        d.text((x, y), line, fill=20, font=font)
        y += int(font_px * gap)
    return img


def degrade(img, noise=0.0, blur=0.0, rotate=0.0, seed=1):
    """Ta sama kolejność co w make_images.py: obrót, rozmycie, szum."""
    rnd = random.Random(seed)
    if rotate:
        img = img.rotate(rotate, resample=Image.BICUBIC, fillcolor=255, expand=False)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    if noise:
        px = img.load()
        for _ in range(int(img.width * img.height * noise)):
            px[rnd.randrange(img.width), rnd.randrange(img.height)] = rnd.choice((0, 255, rnd.randrange(256)))
    return img


def two_columns():
    img = Image.new("L", (2480, 1600), 255)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(REG), 48)
    for c, col in enumerate(COLUMNS):
        for i, line in enumerate(col):
            d.text((200 + c * 1200, 200 + i * 86), line, fill=20, font=font)
    return img


def scan_page(lines):
    """Strona skanu do PDF: A4 w 200 DPI (1654 × 2339), bez szumu."""
    return draw_page(lines, (1654, 2339), 34, 160, 160)


def binarize(img):
    return img.point(lambda v: 255 if v > 127 else 0).convert("1")


def write_huge_png(path, w, h, band_text):
    """PNG 1-bitowy 50000 × 50000 bez pełnego bufora: wiersze lecą strumieniem przez zlib.
    Biały obraz z jednym pasem tekstu; plik ma kilkaset KB, a pamięć rzędu kilku MB."""
    row = (w + 7) // 8
    band = Image.new("L", (w, 100), 255)
    ImageDraw.Draw(band).text((2000, 20), band_text, fill=0, font=ImageFont.truetype(str(REG), 48))
    band_bits = binarize(band).tobytes("raw", "1")
    band_y = h // 2
    white = b"\x00" + b"\xff" * row
    comp = zlib.compressobj(9)
    pending = bytearray()

    def chunk(f, typ, data):
        f.write(struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        chunk(f, b"IHDR", struct.pack(">IIBBBBB", w, h, 1, 0, 0, 0, 0))
        for y in range(h):
            if band_y <= y < band_y + 100:
                r = y - band_y
                line = b"\x00" + band_bits[r * row:(r + 1) * row]
            else:
                line = white
            pending += comp.compress(line)
            if len(pending) >= 1 << 16:
                chunk(f, b"IDAT", bytes(pending))
                pending.clear()
        pending += comp.flush()
        if pending:
            chunk(f, b"IDAT", bytes(pending))
        chunk(f, b"IEND", b"")


def images():
    # skany PNG w skali szarości zamiast RGB (szum po RGB przekroczyłby 2 MB)
    base = lambda size, px: draw_page(LINES, size, px, 200, 200)
    base_big = base((2480, 3508), 48)
    base_big.save(OUT / "skan-czysty.png", optimize=True)
    degrade(base_big, noise=0.02, blur=1.2, seed=2).save(OUT / "skan-szum.png", optimize=True)
    degrade(base_big, rotate=1.5, blur=0.6, seed=3).save(OUT / "skan-obrot.png", optimize=True)
    base((1654, 2339), 28).save(OUT / "skan-maly.png", optimize=True)
    two_columns().save(OUT / "dwie-kolumny.png", optimize=True)
    rnd = random.Random(7)
    img = Image.new("RGB", (3000, 2000), (120, 160, 200))
    d = ImageDraw.Draw(img)
    for _ in range(60):
        x, y, r = rnd.randrange(3000), rnd.randrange(2000), rnd.randrange(40, 300)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    img.filter(ImageFilter.GaussianBlur(6)).save(OUT / "zdjecie-bez-tekstu.png", optimize=True)

    # JPEG z EXIF Orientation=6: piksele leżą obrócone o 90° (ROTATE_90 = w lewo), viewer obraca w prawo
    upright = base_big
    stored = upright.transpose(Image.ROTATE_90)
    exif = Image.Exif()
    exif[0x0112] = 6
    stored.save(OUT / "obrot-exif.jpg", "JPEG", quality=90, exif=exif.tobytes())
    back = ImageOps.exif_transpose(Image.open(OUT / "obrot-exif.jpg"))
    assert back.size == upright.size, (back.size, upright.size)

    # TIFF wielostronicowy, 1-bit, kompresja Group 4 (małe pliki)
    pages = [binarize(scan_page(LETTER)), binarize(scan_page(LINES[6:]))]
    pages[0].save(OUT / "wielostronicowy.tiff", save_all=True, append_images=pages[1:],
                  compression="group4", dpi=(200, 200))

    # HEIC (libheif przez pillow-heif, ta sama wersja co make-heic.sh)
    pillow_heif.register_heif_opener()
    scan_page(HEIC_LINES).convert("RGB").save(OUT / "zdjecie.heic", format="HEIF", quality=90)

    write_huge_png(OUT / "obraz-ogromny.png", 50000, 50000, BIG_LINE)

    # Losowe bajty z ustalonym ziarnem: zły PDF i zły PNG
    (OUT / "losowe.pdf").write_bytes(b"%PDF-1.4\n" + random.Random(11).randbytes(24 * 1024))
    (OUT / "losowe.png").write_bytes(b"\x89PNG\r\n\x1a\n" + random.Random(12).randbytes(24 * 1024))


# ---------- PDF ----------

def finish(writer, name):
    """Stałe daty i ID (Pillow i soffice wpisują czas bieżący i losowe ID)."""
    writer.add_metadata({"/Producer": PRODUCER, "/Creator": PRODUCER,
                         "/CreationDate": DATE, "/ModDate": DATE})
    digest = hashlib.md5(name.encode("utf-8")).digest()
    writer._ID = ArrayObject([ByteStringObject(digest), ByteStringObject(digest)])
    return writer


def save_pdf(writer, name):
    with open(OUT / name, "wb") as f:
        finish(writer, name).write(f)


def fodt(lines):
    """Płaski ODF: strona 1 to nagłówek i akapity z LINES, strona 2 to dwie kolumny (sekcja z columns)."""
    ns = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
          'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
          'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
          'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
          'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
          'xmlns:dc="http://purl.org/dc/elements/1.1/" '
          'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" '
          'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"')
    para = lambda s, style="Standard": f'<text:p text:style-name="{style}">{escape(s)}</text:p>'
    body = [f'<text:h text:style-name="H1" text:outline-level="1">{escape(TITLE1)}</text:h>']
    body += [para(s) for s in lines]
    body.append(f'<text:h text:style-name="HPb" text:outline-level="2">{escape(TITLE2)}</text:h>')
    body.append('<text:section text:style-name="Kolumny" text:name="Kolumny1">')
    body += [para(s) for s in COLUMNS[0] + COLUMNS[1]]
    body.append("</text:section>")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document {ns} office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta><dc:title>Dokument testowy OCR</dc:title><meta:creation-date>2026-01-01T00:00:00</meta:creation-date></office:meta>
<office:font-face-decls>
<style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'" style:font-family-generic="swiss"/>
</office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.2cm"/>
<style:text-properties style:font-name="Liberation Sans" fo:font-size="12pt" fo:language="pl" fo:country="PL"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="H1" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
<style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>
<style:style style:name="H2" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
<style:text-properties fo:font-size="14pt" fo:font-weight="bold"/></style:style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"
 fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2.5cm" fo:margin-right="2.5cm"/></style:page-layout>
<style:style style:name="HPb" style:family="paragraph" style:parent-style-name="H2">
<style:paragraph-properties fo:break-before="page"/></style:style>
<style:style style:name="Kolumny" style:family="section">
<style:section-properties style:editable="false"><style:columns fo:column-count="2" fo:column-gap="0.8cm"/></style:section-properties></style:style>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
<office:body><office:text>
{chr(10).join(body)}
</office:text></office:body></office:document>
"""


def text_pdf():
    """pdf-tekst: soffice zamienia FODT w PDF z warstwą tekstu, potem stałe metadane."""
    profile = tempfile.mkdtemp(prefix="lo-profile-")
    try:
        (WORK / "tekst.fodt").write_text(fodt(LINES), encoding="utf-8")
        subprocess.run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless",
                        "--convert-to", "pdf", "--outdir", str(WORK), str(WORK / "tekst.fodt")],
                       check=True, capture_output=True)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    out = WORK / "tekst.pdf"
    if not out.is_file() or out.stat().st_size == 0:
        raise SystemExit("soffice nie zrobił tekst.pdf")
    save_pdf(PdfWriter(clone_from=PdfReader(out)), "pdf-tekst.pdf")


def scan_pdf():
    pages = [scan_page(LINES), scan_page(LETTER)]
    tmp = WORK / "skan.pdf"
    pages[0].save(tmp, "PDF", save_all=True, append_images=pages[1:], resolution=200.0)
    save_pdf(PdfWriter(clone_from=PdfReader(tmp)), "pdf-skan.pdf")


def mixed_pdf():
    tekst, skan = PdfReader(OUT / "pdf-tekst.pdf"), PdfReader(OUT / "pdf-skan.pdf")
    w = PdfWriter()
    w.add_page(tekst.pages[0])
    w.add_page(skan.pages[1])
    save_pdf(w, "pdf-mieszany.pdf")


def password_pdf():
    w = PdfWriter(clone_from=PdfReader(OUT / "pdf-tekst.pdf"))
    finish(w, "pdf-haslo.pdf")
    # pypdf losuje sól, klucz pliku i IV (także przy zapisie zaszyfrowanych napisów) z secrets:
    # ziarno daje powtarzalny plik; to dane testowe, nie prawdziwe szyfrowanie
    rng = random.Random(21)
    original = secrets.token_bytes
    secrets.token_bytes = lambda n=32: rng.randbytes(n)
    try:
        w.encrypt(user_password=HASLO, owner_password=WLASCICIEL, algorithm="AES-256")
        with open(OUT / "pdf-haslo.pdf", "wb") as f:
            w.write(f)
    finally:
        secrets.token_bytes = original


def garbled_font_pdf():
    """Ręcznie napisany PDF: Type0/Identity-H, font TrueType osadzony, bez ToUnicode i bez cmap.
    Glify rysują się poprawnie, ale wyjęcie tekstu nie daje liter."""
    font = TTFont(str(REG), recalcTimestamp=False)  # bez czasu modyfikacji w tablicy head
    cmap = font.getBestCmap()
    lines = LETTER
    hexes = []
    widths = {}  # gid -> szerokość w 1/1000 em (tablica /W, bez niej odstępy są krzywe)
    upm = font["head"].unitsPerEm
    for line in lines:
        gids = [font.getGlyphID(cmap[ord(c)]) for c in line]
        hexes.append("".join(f"{g:04X}" for g in gids))
        for g in gids:
            widths[g] = round(font["hmtx"][font.getGlyphName(g)][0] * 1000 / upm)
    w_array = " ".join(f"{g} [{w}]" for g, w in sorted(widths.items()))
    del font["cmap"]
    buf = io.BytesIO()
    font.save(buf)
    font_raw = buf.getvalue()
    font_z = zlib.compress(font_raw, 9)

    content = ["BT", "/F1 16 Tf", "50 780 Td"]
    for h in hexes:
        content.append(f"<{h}> Tj")
        content.append("0 -26 Td")
    content.append("ET")
    stream = "\n".join(content).encode()

    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H "
        b"/DescendantFonts [6 0 R] >>",
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        b"/FontDescriptor 7 0 R /DW 600 /W [" + w_array.encode() + b"] /CIDToGIDMap /Identity >>",
        b"<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [-200 -220 1200 1000] "
        b"/ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 716 /StemV 80 /FontFile2 8 0 R >>",
        b"<< /Length %d /Length1 %d /Filter /FlateDecode >>\nstream\n" % (len(font_z), len(font_raw))
        + font_z + b"\nendstream",
        b"<< /Producer (%s) /CreationDate (%s) >>" % (PRODUCER.encode(), DATE.encode()),
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R /ID [<%s> <%s>] >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objs) + 1, len(objs), b"ab" * 16, b"ab" * 16, xref)
    (OUT / "pdf-zly-font.pdf").write_bytes(bytes(out))


def truncated():
    data = (OUT / "pdf-tekst.pdf").read_bytes()
    (OUT / "obciety.pdf").write_bytes(data[: int(len(data) * 0.6)])


def expected_files():
    expected("pdf-tekst.pdf", [TITLE1] + LINES, [TITLE2] + COLUMNS[0] + COLUMNS[1])
    expected("pdf-skan.pdf", LINES, LETTER)
    expected("pdf-mieszany.pdf", [TITLE1] + LINES, LETTER)
    expected("pdf-haslo.pdf")  # zabezpieczony: bez tekstu
    expected("pdf-zly-font.pdf", LETTER)
    expected("skan-czysty.png", LINES)
    expected("skan-szum.png", LINES)
    expected("skan-obrot.png", LINES)
    expected("skan-maly.png", LINES)
    expected("dwie-kolumny.png", COLUMNS[0] + COLUMNS[1])
    expected("zdjecie-bez-tekstu.png")
    expected("obrot-exif.jpg", LINES)
    expected("wielostronicowy.tiff", LETTER, LINES[6:])
    expected("zdjecie.heic", HEIC_LINES)
    expected("obraz-ogromny.png")  # flaga: ucięte/błąd, bez tekstu
    expected("obciety.pdf")  # flaga: ucięte, bez tekstu
    expected("losowe.pdf")
    expected("losowe.png")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    images()
    text_pdf()
    scan_pdf()
    mixed_pdf()
    password_pdf()
    garbled_font_pdf()
    truncated()
    expected_files()
    print(f"gotowe: {len(list(OUT.iterdir()))} plików w {OUT}")


if __name__ == "__main__":
    main()
