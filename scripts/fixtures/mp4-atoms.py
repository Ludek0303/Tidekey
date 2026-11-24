#!/usr/bin/env python3
"""Wypisuje kolejność atomów najwyższego poziomu w pliku MP4/MOV (np. czy moov jest przed mdat).

Wywołanie: python3 mp4-atoms.py <plik> [<plik> ...]
"""
import os
import struct
import sys


def top_level_atoms(path):
    total = os.path.getsize(path)
    atoms = []
    pos = 0
    with open(path, "rb") as f:
        while pos + 8 <= total:
            f.seek(pos)
            size, kind = struct.unpack(">I4s", f.read(8))
            header = 8
            if size == 1:
                size = struct.unpack(">Q", f.read(8))[0]
                header = 16
            elif size == 0:
                size = total - pos
            if size < header:
                break
            atoms.append((kind.decode("latin1"), pos, size))
            pos += size
    return atoms


if __name__ == "__main__":
    for name in sys.argv[1:]:
        atoms = top_level_atoms(name)
        print(os.path.basename(name) + ": " + " ".join(f"{k}@{p}({s} B)" for k, p, s in atoms))
