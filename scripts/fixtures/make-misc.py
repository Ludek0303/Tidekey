#!/usr/bin/env python3
"""Pliki złych danych i granic: losowe bajty z fałszywym rozszerzeniem, pliki o granicznych rozmiarach,
ZIP z rozszerzeniem .pdf, pusty plik i bardzo długa polska nazwa.

Wywołanie: python3 make-misc.py <katalog-wyjściowy>. Losowe bajty: random.Random(7), wynik powtarzalny.
"""
import io
import os
import random
import sys
import zipfile

OUT = sys.argv[1]
OLE2 = bytes.fromhex("D0CF11E0A1B11AE1")
EBML = bytes.fromhex("1A45DFA3")
LONG_NAME = ("bardzo długa nazwa pliku z polskimi znakami zażółć gęślą jaźń — "
             "wersja ostateczna poprawiona po uwagach.txt")


def path(name):
    return os.path.join(OUT, name)


def write(name, data):
    with open(path(name), "wb") as f:
        f.write(data)


def random_bytes(n, seed=7):
    return random.Random(seed).randbytes(n)


def program_exe():
    write("program.exe", b"MZ" + random_bytes(64 * 1024 - 2))


def fake_formats():
    write("losowe.dwg", b"AC1032" + random_bytes(32 * 1024))
    write("losowe.mkv", EBML + random_bytes(32 * 1024))
    write("losowe.doc", OLE2 + random_bytes(32 * 1024))
    write("losowe.ppt", OLE2 + random_bytes(32 * 1024))


def boundaries():
    write("pusty.txt", b"")
    write("granica-1MiB.bin", random_bytes(1024 * 1024))
    write("granica-1MiB+1.bin", random_bytes(1024 * 1024 + 1))


def zip_as_pdf():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo("notatka.txt", date_time=(2026, 1, 1, 0, 0, 0))
        z.writestr(info, "To jest prawdziwy ZIP, a nie PDF.\n".encode("utf-8"))
    write("pdf-a-w-srodku-zip.pdf", buf.getvalue())


def long_name():
    if len(LONG_NAME.encode("utf-8")) > 255:
        raise SystemExit("nazwa pliku za długa dla większości systemów")
    write(LONG_NAME, "Wersja ostateczna: plik z bardzo długą nazwą.\n".encode("utf-8"))


def main():
    os.makedirs(OUT, exist_ok=True)
    program_exe()
    fake_formats()
    boundaries()
    zip_as_pdf()
    long_name()


if __name__ == "__main__":
    main()
