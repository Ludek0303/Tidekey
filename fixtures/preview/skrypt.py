"""Mały skrypt testowy: liczy sumy z pliku CSV i wypisuje podsumowanie."""
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
