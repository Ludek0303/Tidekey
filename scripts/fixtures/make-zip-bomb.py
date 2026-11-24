#!/usr/bin/env python3
"""ZIP-bomba do testów: jeden wpis „zera.bin” o deklarowanym rozmiarze 2 GB zer (ok. 2 MB na dysku).

Plik nie jest zapisany w repo: test tworzy go w katalogu tymczasowym.
Wywołanie: python3 make-zip-bomb.py <plik-wyjściowy>  (istniejący plik zostanie nadpisany).
Dane są strumieniowane przez zlib, więc pamięć nie rośnie z rozmiarem.
"""
import struct
import sys
import zlib

SIZE = 2 * 1024 ** 3  # deklarowany rozmiar po rozpakowaniu; mieści się w ZIP bez ZIP64 (< 4 GB)
NAME = b"zera.bin"
CHUNK = 1024 * 1024
DOS_TIME = 0
DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1  # 2026-01-01
LOCAL_FMT = "<IHHHHHIIIHH"  # 30 bajtów
CENTRAL_FMT = "<IHHHHHHIIIHHHHHII"  # 46 bajtów
EOCD_FMT = "<IHHHHIIH"  # 22 bajty


def local_header(crc, csize):
    return struct.pack(LOCAL_FMT, 0x04034B50, 20, 0, 8, DOS_TIME, DOS_DATE, crc, csize, SIZE, len(NAME), 0)


def main(out):
    zero = bytes(CHUNK)
    crc = 0
    comp = zlib.compressobj(9, zlib.DEFLATED, -15)
    with open(out, "wb+") as f:
        f.write(local_header(0, 0) + NAME)  # nagłówek poprawiany po zapisie danych
        csize = 0
        for _ in range(SIZE // CHUNK):
            crc = zlib.crc32(zero, crc)
            block = comp.compress(zero)
            csize += len(block)
            f.write(block)
        tail = comp.flush()
        csize += len(tail)
        f.write(tail)

        f.seek(0)
        f.write(local_header(crc, csize) + NAME)
        f.seek(0, 2)
        central_offset = f.tell()
        central = struct.pack(CENTRAL_FMT, 0x02014B50, 20, 20, 0, 8, DOS_TIME, DOS_DATE, crc, csize, SIZE,
                              len(NAME), 0, 0, 0, 0, 0, 0) + NAME
        f.write(central)
        eocd = struct.pack(EOCD_FMT, 0x06054B50, 0, 0, 1, 1, len(central), central_offset, 0)
        f.write(eocd)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("użycie: make-zip-bomb.py <plik-wyjściowy>")
    main(sys.argv[1])
