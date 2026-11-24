// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SLASH_ITEMS } from "./slash";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, vi } from "vitest";
import { initFormula } from "./formula";
import { blockInsertion, chartBody, chartBlock, chartSource, chartSvg, linkedChart, paintReadingCharts, parseChart, parseValue, resolveChart } from "./charts";

// the first text node: a legend label carries its share in a tspan after it
const texts = (svg: Element, cls: string) => [...svg.querySelectorAll(`.${cls}`)].map((e) => e.firstChild?.textContent);

describe("parseChart and chartSource", () => {
  it("reads Polish decimals, thousand spaces, a minus and the aliases", () => {
    const chart = parseChart("typ: kolowy\ntytul: Sprzedaż\nA: 1 234,5\nB: -3.5\nC: 7");
    expect(chart).toEqual({
      type: "pie",
      title: "Sprzedaż",
      points: [
        { label: "A", value: 1234.5 },
        { label: "B", value: -3.5 },
        { label: "C", value: 7 },
      ],
      skipped: 0,
      source: null,
    });
    expect(parseChart("title: X\nbar: 1\npie: 2").type).toBe("bar");
    expect(parseChart("typ: pie").type).toBe("pie");
  });

  it("takes an unknown or missing type as a bar, and counts the lines it cannot read", () => {
    const chart = parseChart("typ: radar\nAnna: 12\nto nie liczba\nBeata: x\n: 4\n\nCezary: 5");
    expect(chart.type).toBe("bar");
    expect(chart.points.map((p) => p.label)).toEqual(["Anna", "Cezary"]);
    expect(chart.skipped).toBe(3);
  });

  it("keeps a label with a colon and a label that is a meta word, once points have started", () => {
    expect(parseChart("10:30: 5").points).toEqual([{ label: "10:30", value: 5 }]);
    expect(parseChart("A: 1\ntyp: 2").points.map((p) => p.label)).toEqual(["A", "typ"]);
  });

  it("caps the points at 50 and counts the rest as skipped", () => {
    const source = Array.from({ length: 52 }, (_, i) => `P${i}: ${i}`).join("\n");
    const chart = parseChart(source);
    expect(chart.points).toHaveLength(50);
    expect(chart.skipped).toBe(2);
  });

  it("writes the canonical text with a decimal comma, and reads it back unchanged", () => {
    const chart = { type: "pie" as const, title: "Dział 2", points: [{ label: "Ala", value: 30.5 }, { label: "Bob", value: -2 }], skipped: 0, source: null };
    const source = chartSource(chart);
    expect(source).toBe("typ: kołowy\ntytuł: Dział 2\nAla: 30,5\nBob: -2");
    expect(parseChart(source)).toEqual(chart);
    expect(chartBody(chartBlock(chart))).toBe(source);
  });

  it("round-trips a point labelled like a meta line", () => {
    const chart = { type: "bar" as const, title: "", points: [{ label: "typ", value: 1 }, { label: "tytuł", value: 2 }], skipped: 0, source: null };
    expect(parseChart(chartSource(chart))).toEqual(chart);
  });

  it("parses one value the way the note writes it", () => {
    expect(parseValue("12,5")).toBe(12.5);
    expect(parseValue("−4")).toBe(-4);
    expect(parseValue("1 000 000")).toBe(1000000);
    expect(parseValue("1e5")).toBeNull();
    expect(parseValue("")).toBeNull();
  });
});

describe("chartSvg bars", () => {
  const bars = (n: number) => parseChart(Array.from({ length: n }, (_, i) => `P${i}: ${i + 1}`).join("\n"));

  it("draws one mark per point and labels the values up to 12 bars only", () => {
    const few = chartSvg(bars(12));
    expect(few.querySelectorAll(".chart-item")).toHaveLength(12);
    expect(few.querySelectorAll(".chart-mark")).toHaveLength(12);
    expect(texts(few, "chart-value")).toHaveLength(12);
    expect(texts(chartSvg(bars(13)), "chart-value")).toHaveLength(0);
  });

  it("rounds only the data end of a positive bar, and a negative one hangs below the zero baseline", () => {
    const svg = chartSvg(parseChart("Up: 10\nDown: -5"));
    const [up, down] = [...svg.querySelectorAll(".chart-mark")].map((p) => p.getAttribute("d") ?? "");
    const m = (d: string) => /^M([\d.-]+) ([\d.-]+)V([\d.-]+)/.exec(d)!;
    expect(up).toContain("A4 4 0 0 1");
    expect(up.match(/A/g)).toHaveLength(2);
    expect(down).toContain("A4 4 0 0 0");
    // the positive bar starts at the baseline and rises; the negative one starts at the baseline and falls
    expect(Number(m(up)[3])).toBeLessThan(Number(m(up)[2]));
    expect(Number(m(down)[3])).toBeGreaterThan(Number(m(down)[2]));
    expect(m(up)[2]).toBe(m(down)[2]);
  });

  it("uses nice ticks from zero, one to five intervals", () => {
    const svg = chartSvg(parseChart("A: 12\nB: 97"));
    expect(texts(svg, "chart-tick")).toEqual(["0", "50", "100"]);
  });

  it("sets an aria-label that names the chart, its count and its highest value", () => {
    const svg = chartSvg(parseChart("typ: słupkowy\ntytuł: Sprzedaż 2026\nStyczeń: 12\nLuty: 30,5\nMarzec: 18"));
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Wykres słupkowy: Sprzedaż 2026, 3 wartości, najwyższa Luty 30,5");
  });

  it("shows an empty chart as a placeholder", () => {
    const svg = chartSvg(parseChart("typ: kołowy\ntytuł: Pusty"));
    expect(texts(svg, "chart-empty")).toEqual(["Brak danych — kliknij, aby dodać wartości"]);
    expect(svg.getAttribute("aria-label")).toBe("Wykres kołowy: Pusty, brak danych");
  });

  it("gives every bar a tooltip with its label and value", () => {
    const svg = chartSvg(parseChart("Luty: 30,5"));
    expect(svg.querySelector(".chart-item title")?.textContent).toBe("Luty: 30,5");
  });
});

describe("chartSvg pie", () => {
  const pie = (source: string) => chartSvg(parseChart(`typ: kołowy\n${source}`));

  it("folds the eighth slice and beyond into one slice Inne", () => {
    const svg = pie(Array.from({ length: 9 }, (_, i) => `P${i}: ${i + 1}`).join("\n"));
    expect(svg.querySelectorAll(".chart-slice")).toHaveLength(8);
    expect(texts(svg, "chart-legend-label")).toEqual(["P0", "P1", "P2", "P3", "P4", "P5", "P6", "Inne"]);
    expect(svg.querySelector('.chart-item[data-tip^="Inne: 17"]')).not.toBeNull(); // 8 + 9
  });

  it("leaves negative and zero values out of the pie", () => {
    const svg = pie("A: 3\nB: -4\nC: 0\nD: 1");
    expect(texts(svg, "chart-legend-label")).toEqual(["A", "D"]);
  });

  it("shows a legend with percentages, one decimal below 10 percent", () => {
    const svg = pie("A: 75\nB: 2\nC: 23");
    expect(texts(svg, "chart-legend-share")).toEqual(["75%", "2%", "23%"]);
    const small = pie("A: 96\nB: 4");
    expect(texts(small, "chart-legend-share")).toEqual(["96%", "4%"]);
    const tiny = pie("A: 97\nB: 3,5");
    expect(texts(tiny, "chart-legend-share")).toEqual(["97%", "3,5%"]);
  });

  it("writes direct labels on slices only with at most four slices, and at least 8 percent", () => {
    expect(texts(pie("A: 60\nB: 30\nC: 5\nD: 5"), "chart-slice-label")).toEqual(["60%", "30%"]);
    expect(texts(pie("A: 1\nB: 1\nC: 1\nD: 1\nE: 1"), "chart-slice-label")).toEqual([]);
  });

  it("draws a single slice as a full circle without a legend", () => {
    const svg = pie("A: 5");
    expect(svg.querySelector("circle.chart-slice")).not.toBeNull();
    expect(texts(svg, "chart-legend-label")).toEqual([]);
  });
});

describe("linked charts", () => {
  const SALES = "| Miesiąc | Opis | Sprzedaż | Koszt |\n|---|---|---|---|\n| Styczeń | ok | 12,5 | 3 |\n| Luty | ok | 30 | 4 |\n| | ok | 4 | 1 |\n| Marzec | ok | x | 2 |";
  const LINK = "```wykres\ntabela: powyżej\n```";
  /** The chart of the block that starts at the first wykres fence of `note`, resolved as the editor and the reading view do. */
  const at = (note: string) => {
    const from = note.indexOf("```wykres");
    return resolveChart(note, from, note.indexOf("```", from + 9) + 3);
  };

  it("reads the table link and the column, and writes them back", () => {
    const chart = parseChart("typ: kołowy\ntytuł: Udział\ntabela: powyżej\nkolumna: Sprzedaż\nA: 1");
    expect(chart).toEqual({ type: "pie", title: "Udział", points: [], skipped: 0, source: { column: "Sprzedaż" } });
    expect(chartSource(chart)).toBe("typ: kołowy\ntytuł: Udział\ntabela: powyżej\nkolumna: Sprzedaż");
    expect(parseChart(chartSource(chart))).toEqual(chart);
    expect(parseChart("źródło: tabela").source).toEqual({ column: null });
    expect(parseChart("tabela: powyzej").source).toEqual({ column: null });
    expect(parseChart("tabela: gdzieś").source).toBeNull();
    expect(chartSource(parseChart("typ: słupkowy\ntabela: powyżej"))).toBe("typ: słupkowy\ntabela: powyżej");
  });

  it("takes the first column as labels and the first numeric column as values, titled by its header", () => {
    const { chart, error } = at(`${SALES}\n\n${LINK}`);
    expect(error).toBeNull();
    expect(chart.title).toBe("Sprzedaż");
    expect(chart.points).toEqual([
      { label: "Styczeń", value: 12.5 },
      { label: "Luty", value: 30 },
    ]);
    expect(chart.skipped).toBe(2); // the row without a label and the row with text in its value
  });

  it("reads the column named by kolumna, in any case, and titles it by its header", () => {
    const { chart } = at(`${SALES}\n\n\`\`\`wykres\ntabela: powyżej\nkolumna:  koszt \n\`\`\``);
    expect(chart.title).toBe("Koszt");
    expect(chart.points.map((p) => p.value)).toEqual([3, 4, 2]); // the row without a label is skipped
  });

  it("uses the nearest table above the block, and ignores tables below it and inside code fences", () => {
    const before = "| Stare | Liczby |\n|---|---|\n| a | 5 |";
    const below = "| Dalej | Liczby |\n|---|---|\n| b | 9 |";
    const fenced = "```\n| Kod | Liczby |\n|---|---|\n| z | 7 |\n```";
    expect(at(`${before}\n\n${SALES}\n\n${LINK}\n\n${below}`).chart.title).toBe("Sprzedaż");
    expect(at(`${SALES}\n\n${fenced}\n\n${LINK}`).chart.title).toBe("Sprzedaż");
    expect(at(`${before}\n\n${LINK}\n\n${below}`).chart.title).toBe("Liczby");
  });

  it("gives its error when there is no table above, no numeric column, or no column with that name", () => {
    expect(at(LINK).error).toBe("Nad wykresem nie ma tabeli. Wstaw tabelę nad blokiem wykresu albo wpisz wartości.");
    expect(at(`| A | B |\n|---|---|\n| x | y |\n\n${LINK}`).error).toBe("Tabela nad wykresem nie ma kolumny z liczbami.");
    const missing = at(`${SALES}\n\n\`\`\`wykres\ntabela: powyżej\nkolumna: Brak\n\`\`\``);
    expect(missing.error).toBe("W tabeli nad wykresem nie ma kolumny „Brak”.");
    expect(missing.chart.points).toEqual([]);
  });

  it("draws the error in the chart's place, and a linked chart with its points", () => {
    const svg = chartSvg(linkedChart(parseChart(LINK), null).chart, "Nad wykresem nie ma tabeli.");
    expect(svg.getAttribute("aria-label")).toBe("Nad wykresem nie ma tabeli.");
    expect(texts(svg, "chart-empty")).toEqual(["Nad wykresem nie ma tabeli."]);
    const rows = [[{ text: "A", kind: "text" }, { text: "S", kind: "text" }], [{ text: "x", kind: "text" }, { text: "2", kind: "number" }]];
    expect(chartSvg(linkedChart(parseChart(LINK), rows).chart).querySelectorAll(".chart-item")).toHaveLength(1);
  });
});

describe("blockInsertion", () => {
  const block = "```wykres\ntyp: słupkowy\n```";

  it("starts a new line after text, with a blank line before and after the block", () => {
    const doc = "Tekst";
    const { insert, start } = blockInsertion(doc, doc.length, block);
    expect(insert).toBe(`\n\n${block}\n\n`);
    expect(start).toBe(doc.length + 2);
  });

  it("needs no blank line before in an empty note", () => {
    expect(blockInsertion("", 0, block)).toEqual({ insert: `${block}\n\n`, start: 0 });
  });

  it("keeps one blank line when the caret is on an empty line before text", () => {
    const doc = "Tekst\n\nKoniec";
    const at = "Tekst\n".length;
    const { insert } = blockInsertion(doc, at, block);
    expect(insert).toBe(`\n${block}\n`);
    expect(doc.slice(0, at) + insert + doc.slice(at)).toBe(`Tekst\n\n${block}\n\nKoniec`);
  });
});

describe("paintReadingCharts", () => {
  it("replaces a wykres code block with its chart and leaves other code alone", () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre><code class="language-wykres">typ: kołowy\nA: 1\nB: 3</code></pre><pre><code class="language-js">x</code></pre>';
    paintReadingCharts(root, '```wykres\ntyp: kołowy\nA: 1\nB: 3\n```\n\n```js\nx\n```');
    expect(root.querySelector(".chart-box svg")?.getAttribute("aria-label")).toBe("Wykres kołowy, 2 wartości, największa B 75%");
    expect(root.querySelector("pre > code.language-js")).not.toBeNull();
    expect(root.querySelector("pre > code.language-wykres")).toBeNull();
  });
  it("resolves a linked chart from the table above it, as the note has it", () => {
    const root = document.createElement("div");
    const note = "| Miesiąc | Sprzedaż |\n|---|---|\n| Styczeń | 12 |\n\n```wykres\ntabela: powyżej\n```";
    root.innerHTML = '<pre><code class="language-wykres">tabela: powyżej</code></pre>';
    paintReadingCharts(root, note);
    expect(root.querySelector(".chart-box svg")?.getAttribute("aria-label")).toBe("Wykres słupkowy: Sprzedaż, 1 wartość, najwyższa Styczeń 12");
  });

  it("shows the error of a linked chart without a table above it", () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre><code class="language-wykres">tabela: powyżej</code></pre>';
    paintReadingCharts(root, "```wykres\ntabela: powyżej\n```");
    expect(root.querySelector(".chart-box svg")?.getAttribute("aria-label")).toBe("Nad wykresem nie ma tabeli. Wstaw tabelę nad blokiem wykresu albo wpisz wartości.");
  });



describe("the / menu", () => {
  it("offers a chart item that writes a sample block", () => {
    expect(SLASH_ITEMS.some((i) => i.label === "Wykres" && i.keywords.includes("diagram"))).toBe(true);
  });
});

});

// Formulas need wasm: this describe comes last, so the earlier ones read tables without it.
describe("linked charts with formulas", () => {
  beforeAll(async () => {
    const bytes = readFileSync(resolve(__dirname, "wasm/notes_web_bg.wasm"));
    vi.stubGlobal("fetch", async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }));
    await initFormula();
    vi.unstubAllGlobals();
  });

  it("plots the evaluated result of a formula cell", () => {
    const note = "| Część | Wartość |\n|---|---|\n| A | 2 |\n| B | 3 |\n| Suma | =SUMA(B2:B3) |\n\n```wykres\ntabela: powyżej\n```";
    const from = note.indexOf("```wykres");
    expect(resolveChart(note, from, note.length).chart.points).toEqual([
      { label: "A", value: 2 },
      { label: "B", value: 3 },
      { label: "Suma", value: 5 },
    ]);
  });
});
