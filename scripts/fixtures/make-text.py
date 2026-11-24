#!/usr/bin/env python3
"""Pliki tekstowe, kod, CSV, log i archiwum ZIP z polskimi nazwami (UTF-8).

Wywołanie: python3 make-text.py <katalog-wyjściowy>. Dane losowe mają stałe ziarno (random.Random(7)).
"""
import csv
import io
import json
import os
import random
import sys
import zipfile

OUT = sys.argv[1]


def path(name):
    return os.path.join(OUT, name)


def write_text(name, text):
    with open(path(name), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


NOTATKI = """Notatki z przeglądu projektu „Ogród wspólnoty”

Zażółć gęślą jaźń: ten plik sprawdza polskie znaki w podglądzie tekstu. Ąą Ćć Ęę Łł Ńń Óó Śś Źź Żż.

Lista zadań:
- przygotować plan nasadzeń na wiosnę,
- sprawdzić dostawę ziemi (4,5 t, faktura nr 2026/117),
- zamówić ławki do altany — rozmowa w czwartek o 14:30.

Uwagi: zażółcona gęś, łódź i świerszcz. Ścieżka: C:\\Dokumenty\\Ogród\\plan.txt
Pusta linia poniżej, potem długi wiersz bez spacji dla testu zawijania:
Dlugiwierszbezspacjidlategozeniesiezawijacsieaniedoprzewijaniazaktorejstanieokno.zażółćgęśląjaźń.0123456789.0123456789.0123456789.0123456789.0123456789.0123456789.

Koniec notatek.
"""

SKRYPT_PY = '''"""Mały skrypt testowy: liczy sumy z pliku CSV i wypisuje podsumowanie."""
import csv
import sys
from decimal import Decimal


def suma(sciezka: str) -> Decimal:
    total = Decimal("0")
    with open(sciezka, encoding="utf-8", newline="") as f:
        for wiersz in csv.DictReader(f, delimiter=";"):
            total += Decimal(wiersz["Kwota zł"].replace(",", "."))
    return total


if __name__ == "__main__":
    print(f"Suma: {suma(sys.argv[1]):.2f} zł")
'''

DANE_JSON = {
    "projekt": "Ogród wspólnoty",
    "wersja": 3,
    "aktywny": True,
    "uczestnicy": [
        {"imie": "Zofia", "rola": "koordynatorka", "godziny": 12.5},
        {"imie": "Łukasz", "rola": "skarbnik", "godziny": 3},
    ],
    "uwagi": None,
    "tagi": ["ogród", "wiosna", "żółć"],
}

STYL_CSS = """/* Plik testowy: arkusz stylów do podglądu kodu */
:root {
  --kolor-tla: #f7f5ef;
  --kolor-tekstu: #1d2430;
}

body {
  margin: 0;
  background: var(--kolor-tla);
  color: var(--kolor-tekstu);
  font-family: "Source Serif Pro", Georgia, serif;
}

h1::before {
  content: "❦ ";
}
"""

STRONA_HTML = """<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <title>Strona testowa</title>
  <script>alert("Ten skrypt nie może się uruchomić w podglądzie");</script>
</head>
<body onload="alert('onload')">
  <h1>Podgląd HTML</h1>
  <p>Ten tekst ma być pokazany jako źródło, a nie jako strona.</p>
  <img src="http://127.0.0.1:9/zdjecie.png" alt="zdalny obraz">
</body>
</html>
"""


def klienci_csv():
    rng = random.Random(7)
    imiona = ["Anna", "Piotr", "Zofia", "Łukasz", "Małgorzata", "Jędrzej", "Ewa", "Tomasz", "Żaneta", "Mateusz"]
    nazwiska = ["Kowalska", "Wiśniewski", "Zieliński", "Dąbrowski", "Szymańska", "Król", "Górska", "Mazur"]
    miasta = ["Gdańsk", "Łódź", "Kraków", "Wrocław", "Świdnica", "Zielona Góra", "Poznań"]
    statusy = ["aktywny", "zawieszony", "nowy"]
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", lineterminator="\n")
    writer.writerow(["Id", "Imię", "Nazwisko", "Miasto", "Adres", "Kwota zł", "Data", "Status"])
    for i in range(1, 201):
        kwota = rng.randint(1000, 999999) / 100
        dzien = rng.randint(1, 28)
        miesiac = rng.randint(1, 12)
        adres = f"ul. Długa {rng.randint(1, 99)}"
        if i % 17 == 0:
            adres += "; lok. 2"  # pole z średnikiem: musi być w cudzysłowie (RFC 4180)
        writer.writerow([
            i, rng.choice(imiona), rng.choice(nazwiska), rng.choice(miasta), adres,
            f"{kwota:.2f}".replace(".", ","), f"{dzien:02d}.{miesiac:02d}.2026", rng.choice(statusy),
        ])
    write_text("klienci.csv", buf.getvalue())


def dziennik_log():
    rng = random.Random(7)
    komunikaty = [
        ("INFO", "Synchronizacja zakończona, zmian: {n}"),
        ("INFO", "Otwarto notatkę „Plan nasadzeń”"),
        ("WARN", "Plik ma polskie znaki w nazwie: zażółć.txt"),
        ("DEBUG", "Indeks odświeżony w {n} ms"),
        ("ERROR", "Nie udało się zapisać pliku: brak miejsca ({n} B)"),
    ]
    lines = []
    for i in range(200):
        poziom, tekst = rng.choice(komunikaty)
        godzina = f"2026-03-{1 + i // 40:02d} {(8 + i // 10) % 24:02d}:{(i * 7) % 60:02d}:{(i * 13) % 60:02d}"
        lines.append(f"{godzina} [{poziom:<5}] {tekst.format(n=rng.randint(1, 9999))}")
    write_text("dziennik.log", "\n".join(lines) + "\n")


def archiwum_zip():
    entries = [
        ("README.txt", "Archiwum testowe z polskimi nazwami.\n".encode("utf-8")),
        ("dokumenty/notatka żółta.txt", "Zażółć gęślą jaźń.\n".encode("utf-8")),
        ("dokumenty/plan-łódź.txt", b"Plan na 2026.\n"),
        ("dokumenty/Świdnica — mapa.txt", "Mapa w katalogu.\n".encode("utf-8")),
        ("obrazy/ikona.txt", "Ikona: zielony liść.\n".encode("utf-8")),
        ("pusty katalog/", b""),
    ]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            if name.endswith("/"):
                info.external_attr = (0o40755 << 16) | 0x10
                z.writestr(info, b"")
            else:
                z.writestr(info, data)
    with open(path("archiwum.zip"), "wb") as f:
        f.write(buf.getvalue())


def main():
    os.makedirs(OUT, exist_ok=True)
    write_text("notatki.txt", NOTATKI)
    write_text("skrypt.py", SKRYPT_PY)
    write_text("dane.json", json.dumps(DANE_JSON, ensure_ascii=False, indent=2) + "\n")
    write_text("styl.css", STYL_CSS)
    write_text("strona.html", STRONA_HTML)
    klienci_csv()
    dziennik_log()
    archiwum_zip()


if __name__ == "__main__":
    main()
