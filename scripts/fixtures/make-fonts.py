#!/usr/bin/env python3
"""Fonty testowe zbudowane od zera przez fontTools (bez kopii fontów systemowych).

Każdy glif to prostokąt; znaki z diakrytykami dostają dodatkowy prostokąt nad literą.
Wynik: font.ttf, font.otf, font.woff. Nazwa kroju: „Podgląd Test”.
Wywołanie: python3 make-fonts.py <katalog-wyjściowy>.
"""
import sys
import unicodedata

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

OUT = sys.argv[1]
FAMILY = "Podgląd Test"
TEXT = "Zażółć gęślą jaźń 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz ĄĆĘŁŃÓŚŹŻąćęłńóśźż"
CHARS = sorted(set(TEXT.replace(" ", "")))
ADVANCE = 600
ASCENT, DESCENT = 800, -200


def glyph_name(ch):
    return "uni%04X" % ord(ch)


def rect(pen, x0, y0, x1, y1):
    # kontur zgodnie z ruchem wskazówek zegara (TrueType/CFF wypełnia wnętrze niezależnie od kierunku)
    pen.moveTo((x0, y0))
    pen.lineTo((x0, y1))
    pen.lineTo((x1, y1))
    pen.lineTo((x1, y0))
    pen.closePath()


def draw_char(pen, ch):
    """Prostokąt bryły; diakrytyk = mały prostokąt nad literą. Spacja: tylko odstęp."""
    if ch == " ":
        return
    rect(pen, 60, 0, ADVANCE - 60, 640)
    if unicodedata.normalize("NFD", ch) != ch:
        rect(pen, 180, 700, 420, 820)


def glyph_order():
    return [".notdef", "space"] + [glyph_name(c) for c in CHARS]


def cmap():
    mapping = {0x20: "space"}
    mapping.update({ord(c): glyph_name(c) for c in CHARS})
    return mapping


def common(fb):
    names = {"familyName": FAMILY, "styleName": "Regular", "fullName": FAMILY + " Regular",
             "psName": "PodgladTest-Regular"}
    fb.setupNameTable(names)
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=DESCENT, sTypoLineGap=0,
                usWinAscent=ASCENT, usWinDescent=-DESCENT)
    fb.setupPost()
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT)
    # fixed date (2026-01-01, LONGDATETIME epoch 1904) so the output is reproducible
    fb.font["head"].created = fb.font["head"].modified = 3850070400
    fb.font.recalcTimestamp = False  # fontTools would otherwise rewrite `modified` on save


def build_ttf(path):
    fb = FontBuilder(1000, isTTF=True)
    order = glyph_order()
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap())
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(None)
        if name not in (".notdef", "space"):
            draw_char(pen, chr(int(name[3:], 16)))
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (ADVANCE, 0) for name in order})
    common(fb)
    fb.save(path)


def build_otf(path):
    fb = FontBuilder(1000, isTTF=False)
    order = glyph_order()
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap())
    charstrings = {}
    for name in order:
        pen = T2CharStringPen(ADVANCE, None)
        if name not in (".notdef", "space"):
            draw_char(pen, chr(int(name[3:], 16)))
        charstrings[name] = pen.getCharString()
    fb.setupCFF(
        "PodgladTest-Regular",
        # CFF top dict only takes Latin-1; the name table (nameID 1, 4) keeps the Polish name
        {"FullName": "Podglad Test Regular", "FamilyName": "Podglad Test", "Weight": "Regular"},
        charstrings,
        {},
    )
    fb.setupHorizontalMetrics({name: (ADVANCE, 0) for name in order})
    common(fb)
    fb.save(path)


def build_woff(ttf_path, path):
    font = TTFont(ttf_path, recalcTimestamp=False)
    font.flavor = "woff"
    font.save(path)


def main():
    ttf = OUT + "/font.ttf"
    build_ttf(ttf)
    build_otf(OUT + "/font.otf")
    build_woff(ttf, OUT + "/font.woff")


if __name__ == "__main__":
    main()
