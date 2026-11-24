#!/usr/bin/env python3
"""Źródła dokumentów biurowych: płaski ODF (FODT/FODS/FODP) z obrazem i danymi, które make-preview-fixtures.sh
zamienia na DOCX, DOC, ODT, PDF, XLSX, XLS, ODS, PPTX i PPT przez soffice.

Tu też powstaje DOCX z obrazem podpiętym pod zewnętrzny adres (pułapka: podgląd nie może nic pobierać).

Wywołanie: python3 make-office.py <katalog-roboczy-źródeł> <katalog-wyjściowy>.
"""
import base64
import io
import os
import sys
import zipfile
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image, ImageDraw

WORK = sys.argv[1]
OUT = sys.argv[2]

NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
    'xmlns:xlink="http://www.w3.org/1999/xlink" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" '
    'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" '
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
    'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"'
)
CREATED = "2026-01-01T00:00:00"


def doc_open(mimetype, title):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<office:document {NS} office:version="1.3" office:mimetype="{mimetype}">\n'
        f"<office:meta><dc:title>{escape(title)}</dc:title>"
        f"<meta:creation-date>{CREATED}</meta:creation-date><dc:date>{CREATED}</dc:date></office:meta>\n"
    )


def picture():
    """Obraz 480 x 300 do wstawienia w dokumencie i prezentacji (PNG, bez przezroczystości)."""
    xs = np.linspace(60, 230, 480, dtype=np.float32)
    ys = np.linspace(40, 200, 300, dtype=np.float32)
    arr = np.zeros((300, 480, 3), dtype=np.float32)
    arr[..., 0] = xs[None, :]
    arr[..., 1] = ys[:, None]
    arr[..., 2] = 150.0
    img = Image.fromarray(arr.astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(img)
    draw.ellipse((300, 60, 440, 200), fill=(250, 210, 40))
    draw.rectangle((40, 150, 200, 260), fill=(30, 120, 210))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def frame_image(b64, width, height, name):
    return (
        f'<draw:frame draw:style-name="fr1" draw:name="{name}" text:anchor-type="as-char" '
        f'svg:width="{width}" svg:height="{height}" draw:z-index="0">'
        f"<draw:image><office:binary-data>{b64}</office:binary-data></draw:image></draw:frame>"
    )


def writer_doc(b64):
    paragraphs = [
        '<text:h text:style-name="Heading_20_1" text:outline-level="1">Dokument testowy podglądu</text:h>',
        '<text:p text:style-name="Standard">Ten dokument ma nagłówki, akapity, tabelę i obraz. '
        "Zażółć gęślą jaźń: polskie znaki w akapicie, pogrubienie i kursywa w jednym zdaniu.</text:p>",
        '<text:h text:style-name="Heading_20_2" text:outline-level="2">1. Wstęp</text:h>',
        '<text:p text:style-name="Standard">Strona pierwsza: nagłówek, dwa akapity i obraz wstawiony w tekst. '
        "Podgląd ma pokazać układ strony, a nie edytować treść.</text:p>",
        '<text:p text:style-name="Standard">Drugi akapit zawiera więcej tekstu, żeby sprawdzić zawijanie wierszy '
        "przy szerokości strony A4 z marginesami 2,5 cm po obu stronach.</text:p>",
        f'<text:p text:style-name="P_center">{frame_image(b64, "8cm", "5cm", "obraz1")}</text:p>',
        '<text:h text:style-name="P_pb" text:outline-level="2">2. Tabela</text:h>',
    ]
    header = ["Lp", "Pozycja", "Kwota (zł)"]
    rows = [["1", "Ziemia ogrodowa", "4 500,00"], ["2", "Ławki do altany", "1 890,50"],
            ["3", "Nasiona i sadzonki", "320,75"]]
    table = ['<table:table table:name="Tabela1" table:style-name="Tabela1">',
             '<table:table-column table:style-name="Tabela1.A" table:number-columns-repeated="3"/>',
             "<table:table-header-rows><table:table-row>"]
    table += [f'<table:table-cell table:style-name="Tabela1.hcell" office:value-type="string">'
              f'<text:p text:style-name="Standard"><text:span text:style-name="T_bold">{escape(c)}</text:span></text:p>'
              "</table:table-cell>" for c in header]
    table.append("</table:table-row></table:table-header-rows>")
    for row in rows:
        table.append("<table:table-row>")
        table += [f'<table:table-cell table:style-name="Tabela1.cell" office:value-type="string">'
                  f'<text:p text:style-name="Standard">{escape(c)}</text:p></table:table-cell>' for c in row]
        table.append("</table:table-row>")
    table.append("</table:table>")
    paragraphs.append("".join(table))
    paragraphs += [
        '<text:h text:style-name="P_pb" text:outline-level="2">3. Podsumowanie</text:h>',
        '<text:list text:style-name="L1"><text:list-item><text:p text:style-name="Standard">'
        "Pierwszy punkt listy z polskim tekstem: łąka, źródło, świerszcz.</text:p></text:list-item>"
        '<text:list-item><text:p text:style-name="Standard">Drugi punkt listy.</text:p></text:list-item></text:list>',
        '<text:p text:style-name="Standard">Koniec dokumentu testowego.</text:p>',
    ]
    return (
        doc_open("application/vnd.oasis.opendocument.text", "Dokument testowy podglądu")
        + """<office:font-face-decls>
<style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'" style:font-family-generic="roman"/>
</office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.2cm"/>
<style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt" fo:language="pl" fo:country="PL"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
<style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading"
 style:next-style-name="Standard" style:default-outline-level="1"><style:paragraph-properties fo:margin-top="0.4cm"/>
<style:text-properties fo:font-size="20pt"/></style:style>
<style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading"
 style:next-style-name="Standard" style:default-outline-level="2"><style:text-properties fo:font-size="15pt"/></style:style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"
 fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2.5cm" fo:margin-right="2.5cm"/></style:page-layout>
<style:style style:name="P_pb" style:family="paragraph" style:parent-style-name="Heading_20_2">
<style:paragraph-properties fo:break-before="page"/></style:style>
<style:style style:name="P_center" style:family="paragraph" style:parent-style-name="Standard">
<style:paragraph-properties fo:text-align="center"/></style:style>
<style:style style:name="T_bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Tabela1" style:family="table"><style:table-properties style:width="15cm" table:align="left"/></style:style>
<style:style style:name="Tabela1.A" style:family="table-column"><style:table-column-properties style:column-width="5cm"/></style:style>
<style:style style:name="Tabela1.cell" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.1cm"/></style:style>
<style:style style:name="Tabela1.hcell" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.1cm" fo:background-color="#dde6f4"/></style:style>
<style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:wrap="none" style:vertical-pos="top" style:vertical-rel="paragraph" style:horizontal-pos="center" style:horizontal-rel="paragraph" fo:border="none"/></style:style>
<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:space-before="0.5cm" text:min-label-width="0.5cm"/></text:list-level-style-bullet></text:list-style>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
<office:body><office:text>
"""
        + "\n".join(paragraphs)
        + "\n</office:text></office:body></office:document>\n"
    )


def calc_doc(b64_unused):
    """Dwa arkusze: „Plan” (wartości) i „Wykonanie” (formuły odwołujące się do „Plan”); waluta zł, daty,
    scalone komórki i formuły SUM. Wartości w pamięci podręcznej są policzone tutaj, żeby podgląd je widział."""
    plan = [("Ziemia ogrodowa", "2026-03-01", 4500.00), ("Ławki do altany", "2026-04-15", 1890.50),
            ("Nasiona i sadzonki", "2026-03-20", 320.75), ("Narzędzia", "2026-05-02", 1240.00)]
    ratios = [0.92, 1.05, 0.98, 0.85]
    exec_dates = ["2026-03-04", "2026-04-18", "2026-03-22", "2026-05-09"]
    statuses = ["zrealizowane", "zrealizowane", "w toku", "anulowane"]

    def money(value):
        text = f"{value:,.2f}".replace(",", " ").replace(".", ",")
        return text + " zł"

    def cell_money(value, formula=None):
        f = f' table:formula="{formula}"' if formula else ""
        return (f'<table:table-cell table:style-name="ceZl"{f} office:value-type="currency" '
                f'office:currency="PLN" office:value="{value:.2f}"><text:p>{escape(money(value))}</text:p>'
                "</table:table-cell>")

    def cell_text(text, style=None):
        s = f' table:style-name="{style}"' if style else ""
        return f'<table:table-cell{s} office:value-type="string"><text:p>{escape(text)}</text:p></table:table-cell>'

    def cell_date(iso, style="ceData"):
        y, m, d = iso.split("-")
        return (f'<table:table-cell table:style-name="{style}" office:value-type="date" office:date-value="{iso}">'
                f"<text:p>{d}.{m}.{y}</text:p></table:table-cell>")

    def title(text, span):
        return (f'<table:table-cell table:style-name="ceTytul" table:number-columns-spanned="{span}" '
                f'office:value-type="string"><text:p>{escape(text)}</text:p></table:table-cell>'
                f'<table:covered-table-cell table:number-columns-repeated="{span - 1}"/>')

    def header(cols):
        return "<table:table-row>" + "".join(cell_text(c, "ceNaglowek") for c in cols) + "</table:table-row>"

    def sheet(name, title_text, body_rows):
        rows = ["<table:table-row>" + title(title_text, 4) + "</table:table-row>",
                header(["Pozycja", "Termin", "Kwota (zł)", "Status"])]
        rows += body_rows
        return (f'<table:table table:name="{name}" table:style-name="taBlad">'
                '<table:table-column table:style-name="coKolumna" table:number-columns-repeated="4"/>'
                + "".join(rows) + "</table:table>")

    plan_rows = []
    for pozycja, termin, kwota in plan:
        plan_rows.append("<table:table-row>" + cell_text(pozycja) + cell_date(termin)
                         + cell_money(kwota) + cell_text("zaplanowane") + "</table:table-row>")
    total_plan = sum(k for _, _, k in plan)
    plan_rows.append("<table:table-row>" + title("Razem", 2)
                     + cell_money(total_plan, "of:=SUM([.C3:.C6])") + cell_text("") + "</table:table-row>")
    plan_sheet = sheet("Plan", "Plan finansowy 2026", plan_rows)

    exe_rows = []
    total_exe = 0.0
    for i, ((pozycja, _, kwota), ratio) in enumerate(zip(plan, ratios)):
        wykonanie = round(kwota * ratio, 2)
        total_exe += wykonanie
        exe_rows.append("<table:table-row>" + cell_text(pozycja) + cell_date(exec_dates[i])
                        + cell_money(wykonanie, f"of:=[$Plan.C{3 + i}]*{ratio}") + cell_text(statuses[i])
                        + "</table:table-row>")
    exe_rows.append("<table:table-row>" + title("Razem", 2)
                    + cell_money(total_exe, "of:=SUM([.C3:.C6])") + cell_text("") + "</table:table-row>")
    exe_sheet = sheet("Wykonanie", "Wykonanie 2026", exe_rows)

    return (
        doc_open("application/vnd.oasis.opendocument.spreadsheet", "Arkusz testowy podglądu")
        + """<office:font-face-decls>
<style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'" style:font-family-generic="swiss"/>
</office:font-face-decls>
<office:styles><style:default-style style:family="table-cell">
<style:text-properties style:font-name="Liberation Sans" fo:font-size="10pt" fo:language="pl" fo:country="PL"/>
</style:default-style></office:styles>
<office:automatic-styles>
<number:currency-style style:name="N_zl" number:language="pl" number:country="PL">
<number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/>
<number:text> </number:text><number:currency-symbol number:language="pl" number:country="PL">zł</number:currency-symbol>
</number:currency-style>
<style:style style:name="ceZl" style:family="table-cell" style:data-style-name="N_zl"/>
<number:date-style style:name="N_data" number:language="pl" number:country="PL">
<number:day number:style="long"/><number:text>.</number:text><number:month number:style="long"/>
<number:text>.</number:text><number:year number:style="long"/></number:date-style>
<style:style style:name="ceData" style:family="table-cell" style:data-style-name="N_data"/>
<style:style style:name="ceNaglowek" style:family="table-cell"><style:text-properties fo:font-weight="bold"/>
<style:table-cell-properties fo:background-color="#dde6f4"/></style:style>
<style:style style:name="ceTytul" style:family="table-cell"><style:text-properties fo:font-weight="bold" fo:font-size="13pt"/>
<style:table-cell-properties fo:background-color="#f2f2f2"/></style:style>
<style:style style:name="taBlad" style:family="table"><style:table-properties table:display="true"/></style:style>
<style:style style:name="coKolumna" style:family="table-column"><style:table-column-properties style:column-width="4.5cm"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
"""
        + plan_sheet + "\n" + exe_sheet + "\n"
        + "</office:spreadsheet></office:body></office:document>\n"
    )


def impress_doc(b64):
    def box(x, y, w, h, inner, cls=None):
        c = f' presentation:class="{cls}"' if cls else ""
        return (f'<draw:frame draw:name="ramka" svg:x="{x}" svg:y="{y}" svg:width="{w}" svg:height="{h}"{c}>'
                f"<draw:text-box>{inner}</draw:text-box></draw:frame>")

    def title(text):
        return box("1.5cm", "0.8cm", "25cm", "2.5cm", f"<text:p>{escape(text)}</text:p>", "title")

    def bullets(items):
        li = "".join(f"<text:list-item><text:p>{escape(t)}</text:p></text:list-item>" for t in items)
        return box("1.5cm", "4cm", "25cm", "10cm", f"<text:list>{li}</text:list>", "outline")

    def pic():
        return (f'<draw:frame draw:name="obraz" svg:x="6cm" svg:y="4cm" svg:width="16cm" svg:height="10cm">'
                f"<draw:image><office:binary-data>{b64}</office:binary-data></draw:image></draw:frame>")

    def page(n, body):
        return f'<draw:page draw:name="page{n}" draw:style-name="dp1" draw:master-page-name="Default">{body}</draw:page>'

    slides = [
        page(1, title("Prezentacja testowa") + box("1.5cm", "5cm", "25cm", "3cm",
                                                 "<text:p>Podgląd slajdów: tytuł, punkty i obraz.</text:p>")),
        page(2, title("Cele projektu") + bullets(["Zasadzić nowe krzewy", "Odnowić altanę",
                                                  "Zażółcić i ozdobić ogrodzenie"])),
        page(3, title("Obraz na slajdzie") + pic()),
        page(4, title("Podsumowanie") + bullets(["Plan jest zatwierdzony", "Budżet: 8 000 zł",
                                                  "Kolejne spotkanie w maju"])),
    ]
    return (
        doc_open("application/vnd.oasis.opendocument.presentation", "Prezentacja testowa podglądu")
        + """<office:font-face-decls>
<style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'" style:font-family-generic="swiss"/>
</office:font-face-decls>
<office:automatic-styles>
<style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"
 style:print-orientation="landscape"/></style:page-layout>
<style:style style:name="dp1" style:family="drawing-page"/>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
<office:body><office:presentation>
"""
        + "\n".join(slides)
        + "\n</office:presentation></office:body></office:document>\n"
    )


def external_docx():
    """DOCX, którego obraz wskazuje na http://127.0.0.1:9/... (TargetMode="External"). Nie ma części obrazu."""
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" '
          'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          "</Types>")
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
            'officeDocument" Target="word/document.xml"/></Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
                'image" Target="http://127.0.0.1:9/zewnetrzny.png" TargetMode="External"/></Relationships>')
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'
        "<w:p><w:r><w:t>Obraz z zewnętrznego adresu (test: podgląd nie może nic pobrać).</w:t></w:r></w:p>"
        "<w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"2286000\" cy=\"1524000\"/>"
        '<wp:docPr id="1" name="Zewnetrzny"/><a:graphic>'
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        '<pic:nvPicPr><pic:cNvPr id="0" name="zewnetrzny.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:link="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2286000" cy="1524000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>'
        "</wp:inline></w:drawing></w:r></w:p>"
        "<w:sectPr/></w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in [("[Content_Types].xml", ct), ("_rels/.rels", rels),
                           ("word/_rels/document.xml.rels", doc_rels), ("word/document.xml", document)]:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text.encode("utf-8"))
    with open(os.path.join(OUT, "docx-obraz-zewnetrzny.docx"), "wb") as f:
        f.write(buf.getvalue())


def write(name, text):
    with open(os.path.join(WORK, name), "w", encoding="utf-8") as f:
        f.write(text)


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    b64 = picture()
    write("dokument.fodt", writer_doc(b64))
    write("arkusz.fods", calc_doc(b64))
    write("prezentacja.fodp", impress_doc(b64))
    external_docx()


if __name__ == "__main__":
    main()
