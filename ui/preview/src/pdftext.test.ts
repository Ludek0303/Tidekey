import { describe, expect, it } from "vitest";
import { groupLines, joinLine, pageRuns, pageText, PAGE_RUN_LIMIT, textVerdict, type TextRun } from "./pdftext";

// A run of text at (x, y); the width follows the text length at 0.5 em per character, as a typical sans font.
const run = (text: string, x: number, y: number, height = 10): TextRun => ({ text, x, y, width: text.length * height * 0.5, height });

describe("pageText: linie", () => {
  it("dwie linie jedna pod drugą, od góry do dołu", () => {
    const runs = [run("Dolna linia", 72, 680), run("Górna linia", 72, 700)];
    expect(pageText(runs)).toBe("Górna linia\nDolna linia");
  });

  it("jedna linia rozbita na kilka elementów: spacja tylko tam, gdzie jest przerwa", () => {
    // "Zażółć" and "gęślą" touch each other (no gap); "Razem" and "do" have a gap of 8 units (a space)
    const runs = [run("Zażółć", 72, 700), run("gęślą", 72 + 6 * 5, 700), run("Razem", 200, 680), run("do", 200 + 30 + 8, 680)];
    expect(pageText(runs)).toBe("Zażółćgęślą\nRazem do");
  });

  it("elementy z własną spacją na końcu nie dostają podwójnej", () => {
    expect(joinLine([run("tekst ", 72, 700), run("dalej", 72 + 6 * 5 + 6, 700)])).toBe("tekst dalej");
  });

  it("grupowanie: elementy o zbliżonym y w jednej linii, posortowane po x", () => {
    const lines = groupLines([run("b", 150, 700), run("a", 72, 700.5), run("c", 72, 680)]);
    expect(lines.map((l) => l.runs.map((r) => r.text))).toEqual([["a", "b"], ["c"]]);
  });

  it("puste elementy nie tworzą linii", () => {
    expect(pageText([run("   ", 72, 700), run("tekst", 72, 680)])).toBe("tekst");
  });
});

describe("pageText: dwie kolumny", () => {
  it("lewa kolumna najpierw, potem prawa", () => {
    const left = ["Pierwsza kolumna", "zawiera zdania", "o pogodzie", "słoneczna i ciepła"];
    const right = ["Druga kolumna", "opisuje wyniki", "sprzedaży w maju", "wzrost o 12,5"];
    const runs: TextRun[] = [];
    left.forEach((t, i) => runs.push(run(t, 72, 700 - i * 14, 10)));
    right.forEach((t, i) => runs.push(run(t, 330, 700 - i * 14, 10)));
    expect(pageText(runs)).toBe([...left, ...right].join("\n"));
  });

  it("pełnej szerokości nagłówek zostaje na górze, a kolumny pod nim", () => {
    const runs: TextRun[] = [run("Nagłówek na całej szerokości tekstu strony", 72, 740)];
    ["L1 lewa", "L2 lewa", "L3 lewa"].forEach((t, i) => runs.push(run(t, 72, 700 - i * 14)));
    ["P1 prawa", "P2 prawa", "P3 prawa"].forEach((t, i) => runs.push(run(t, 330, 700 - i * 14)));
    expect(pageText(runs).split("\n")).toEqual([
      "Nagłówek na całej szerokości tekstu strony", "L1 lewa", "L2 lewa", "L3 lewa", "P1 prawa", "P2 prawa", "P3 prawa",
    ]);
  });
});

describe("textVerdict", () => {
  it("polski tekst z warstwy jest w porządku", () => {
    const text = "Zażółć gęślą jaźń. Pchnąć w tę łódź jeża lub ośm skrzyń fig. Razem do zapłaty: 1 525,20 zł";
    expect(textVerdict(text)).toBe("ok");
  });

  it("mniej niż 20 liter i cyfr to brak tekstu", () => {
    expect(textVerdict("Krótki tekst")).toBe("no-text");
    expect(textVerdict("")).toBe("no-text");
    expect(textVerdict("!!! ??? --- ... ###")).toBe("no-text");
  });

  it("znaki zastępcze U+FFFD ponad 10% to uszkodzony tekst", () => {
    const text = "Dobry tekst linia pierwsza ok. " + "�".repeat(12);
    expect(textVerdict(text)).toBe("garbled");
  });

  it("znaki prywatne (U+E000–U+F8FF) i sterujące też psują tekst", () => {
    expect(textVerdict("Poprawne słowa w dłuższym zdaniu " + "".repeat(10))).toBe("garbled");
    expect(textVerdict("Poprawne słowa w dłuższym zdaniu " + "\u0001".repeat(10))).toBe("garbled");
  });

  it("mało liter wśród znaków (mniej niż połowa poprawnych) to uszkodzony tekst", () => {
    const symbols = "¤§¶¦¬±×÷^~|<>\\`¦¤§¶¦¬±×÷^~|<>\\`¦¤§¶¦¬±×÷^~|<>\\`";
    expect(textVerdict("abcdefghijklmnopqrstuvwxyz" + symbols)).toBe("garbled");
  });

  it("tekst z interpunkcją i spacjami nie jest uszkodzony", () => {
    expect(textVerdict("(12/03/2026) 100% — kwota: 1.240,00 zł; uwagi: ok.")).toBe("ok");
  });
});

const BOX = { x0: 0, y0: 0, x1: 612, y1: 792 };

describe("pageRuns: granice strony i limit tekstu", () => {
  it("elementy poza boxem strony są odrzucane (także ±5e8)", () => {
    const runs = [run("w środku", 72, 700), run("daleko", 5e8, 690), run("z lewej", -5e8, 680), run("nad stroną", 72, 1e9)];
    const kept = pageRuns(runs, BOX);
    expect(kept.runs.map((r) => r.text)).toEqual(["w środku"]);
    expect(kept.cut).toBe(false);
  });

  it("współrzędne NaN i nieskończone są odrzucane", () => {
    const runs = [run("ok", 72, 700), { ...run("zły", 72, 690), x: Number.NaN }, { ...run("nieskończony", 72, 680), y: Infinity }];
    expect(pageRuns(runs, BOX).runs.map((r) => r.text)).toEqual(["ok"]);
  });

  it("ponad 2 MB tekstu: zbieranie przerwane, strona oznaczona jako ucięta", () => {
    const chunk = "a".repeat(1000);
    const runs: TextRun[] = Array.from({ length: Math.ceil(PAGE_RUN_LIMIT / 1000) + 50 }, (_, i) => run(chunk, 72, 800 - (i % 700) * 0.01));
    const kept = pageRuns(runs, { x0: 0, y0: -1e9, x1: 612, y1: 1e9 });
    expect(kept.cut).toBe(true);
    const total = kept.runs.reduce((n, r) => n + r.text.length, 0);
    expect(total).toBeLessThanOrEqual(PAGE_RUN_LIMIT);
    // the next run would not fit with its separators: the cut is at the limit, not earlier
    expect((kept.runs.length + 1) * (chunk.length + 2)).toBeGreaterThan(PAGE_RUN_LIMIT);
  });

  it("dużo elementów, mało tekstu: wszystkie zostają, bez cięcia", () => {
    const runs = Array.from({ length: 50_000 }, (_, i) => run("x", 72 + (i % 500), 700 - Math.floor(i / 500) * 12));
    const kept = pageRuns(runs, { x0: 0, y0: -1e9, x1: 612, y1: 1e9 });
    expect(kept.runs).toHaveLength(50_000);
    expect(kept.cut).toBe(false);
  });
});

describe("pageText: ekstremalne współrzędne", () => {
  it("rozpiętość większa niż 100 000 jednostek: brak szpalt, każda linia po kolei", () => {
    const runs = [run("lewa góra linii", 0, 700), run("lewa dół", 0, 680), run("prawa daleko", 9e7, 700), run("prawa dół", 9e7, 680)];
    expect(pageText(runs)).toBe("lewa góra linii prawa daleko\nlewa dół prawa dół");
  });

  it("współrzędne ±5e8 bez wycięcia strony: funkcja kończy i nie alokuje zakresu", () => {
    const runs = [run("Pierwsza linia tekstu", 72, 700), run("Druga linia tekstu", 72, 680), run("daleko", 5e8, 690), run("z lewej", -5e8, 690)];
    expect(pageText(runs)).toBe("Pierwsza linia tekstu\nz lewej daleko\nDruga linia tekstu");
  });
});
