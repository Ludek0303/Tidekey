// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { columnName, createGrid } from "./grid";

const headers = (table: HTMLElement): string[] => [...table.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
const rowNumbers = (table: HTMLElement): string[] => [...table.querySelectorAll("tbody th.w")].map((th) => th.textContent ?? "");

describe("columnName", () => {
  it("litery kolumn jak w arkuszu", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(701)).toBe("ZZ");
    expect(columnName(702)).toBe("AAA");
  });
});

describe("createGrid", () => {
  it("nagłówki kolumn A..C i numery wierszy od 1", () => {
    const grid = createGrid([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    const table = grid.querySelector("table") as HTMLElement;
    expect(headers(table)).toEqual(["", "A", "B", "C"]);
    expect(rowNumbers(table)).toEqual(["1", "2"]);
    expect([...table.querySelectorAll("tbody td")].map((td) => td.textContent)).toEqual(["a", "b", "c", "1", "2", "3"]);
  });

  it("tekst komórek przez textContent: HTML z pliku nie tworzy elementów", () => {
    const grid = createGrid([["<img src=x onerror=alert(1)>"]]);
    expect(grid.querySelector("img")).toBeNull();
    expect(grid.querySelector("td")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("maxRows i maxCols ograniczają widok", () => {
    const rows = Array.from({ length: 5 }, () => ["a", "b", "c", "d"]);
    const table = createGrid(rows, { maxRows: 2, maxCols: 2 }).querySelector("table") as HTMLElement;
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(headers(table)).toEqual(["", "A", "B"]);
  });

  it("scalenie 2×2: rowSpan i colSpan, przykryte komórki pominięte", () => {
    const rows = [
      ["x", "x", "p"],
      ["x", "x", "q"],
      ["r", "s", "t"],
    ];
    const table = createGrid(rows, { merges: [{ r: 0, c: 0, rows: 2, cols: 2 }] }).querySelector("table") as HTMLElement;
    const trs = [...table.querySelectorAll("tbody tr")];
    const origin = trs[0].querySelectorAll("td")[0];
    expect(origin.rowSpan).toBe(2);
    expect(origin.colSpan).toBe(2);
    expect([...trs[0].querySelectorAll("td")].map((td) => td.textContent)).toEqual(["x", "p"]);
    expect([...trs[1].querySelectorAll("td")].map((td) => td.textContent)).toEqual(["q"]);
    expect([...trs[2].querySelectorAll("td")].map((td) => td.textContent)).toEqual(["r", "s", "t"]);
  });

  it("align: liczby do prawej, pogrubienie przez b", () => {
    const grid = createGrid(
      [
        ["Pozycja", "Kwota"],
        ["Najem", "36 000,00"],
      ],
      {
        align: (r, c) => (r > 0 && c === 1 ? "right" : "left"),
        bold: (r) => r === 0,
      },
    );
    const trs = grid.querySelectorAll("tbody tr");
    const tds = trs[1].querySelectorAll("td");
    expect(tds[1].classList.contains("n")).toBe(true);
    expect(tds[0].classList.contains("n")).toBe(false);
    expect(trs[0].querySelectorAll("td")[0].querySelector("b")?.textContent).toBe("Pozycja");
    expect(tds[0].querySelector("b")).toBeNull();
  });
});
