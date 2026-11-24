// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PreviewError, type ViewerContext } from "./index";
import { createCsvViewer, guessDelimiter, parseCsv } from "./csv";
import type { Theme } from "../../../src/preview/protocol";

const DEFAULT_THEME: Theme = {
  name: "dark",
  colors: { bg: "#161719", panel: "#1e1f22", text: "#ececf0", muted: "#a6a6b2", accent: "#b4a0ff", border: "#35363c" },
};

describe("parseCsv", () => {
  it("cudzysłowy z separatorem i nową linią w środku pola", () => {
    expect(parseCsv('a;"b;c\nd";e\n', ";", 100)).toEqual({ rows: [["a", "b;c\nd", "e"]], more: false });
  });

  it("podwójny cudzysłów w polu", () => {
    expect(parseCsv('"he said ""hi"""\n', ",", 100).rows).toEqual([['he said "hi"']]);
  });

  it("CRLF i LF", () => {
    expect(parseCsv("a,b\r\nc,d\n", ",", 100).rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("pusty ostatni wiersz pominięty, pusty wiersz w środku zostaje", () => {
    expect(parseCsv("a\n\nb\n", ",", 100).rows).toEqual([["a"], [""], ["b"]]);
    expect(parseCsv("a\n\n", ",", 100).rows).toEqual([["a"]]);
  });

  it("maxRows ustawia more", () => {
    expect(parseCsv("1\n2\n3\n", ",", 2)).toEqual({ rows: [["1"], ["2"]], more: true });
    expect(parseCsv("1\n2\n", ",", 2)).toEqual({ rows: [["1"], ["2"]], more: false });
    expect(parseCsv("1\n2\n\n", ",", 2)).toEqual({ rows: [["1"], ["2"]], more: false });
  });
});

describe("guessDelimiter", () => {
  it("średnik, przecinek, tabulator i kreska pionowa", () => {
    expect(guessDelimiter("a;b;c\n1;2;3\n", "dane.csv")).toBe(";");
    expect(guessDelimiter("a,b,c\n1,2,3\n", "dane.csv")).toBe(",");
    expect(guessDelimiter("a\tb\tc\n1\t2\t3\n", "dane.txt")).toBe("\t");
    expect(guessDelimiter("a|b|c\n1|2|3\n", "dane.csv")).toBe("|");
  });

  it("separatory w cudzysłowie się nie liczą", () => {
    expect(guessDelimiter('"a;b;c",d\n"x;y",z\n', "dane.csv")).toBe(",");
  });

  it("TSV z rozszerzenia to zawsze tabulator", () => {
    expect(guessDelimiter("a,b\n1,2\n", "dane.tsv")).toBe("\t");
  });
});

describe("createCsvViewer", () => {
  const status = vi.fn<(text: string) => void>();
  const ctx = (name: string, size: number): ViewerContext => ({
    host: document.createElement("div"),
    name,
    mime: "text/csv",
    size,
    signal: new AbortController().signal,
    theme: DEFAULT_THEME,
    asset: async () => new ArrayBuffer(0),
    spawnWorker: async () => null,
    status,
    nav: () => undefined,
  });
  const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

  it("siatka z nagłówkami, liczby do prawej i pasek stanu", async () => {
    const c = ctx("klienci.csv", 30);
    const viewer = createCsvViewer();
    await viewer.open(bytes("imie;kwota;uwagi\nAnna;12,50;\nJan;-1 200;ok\n"), c);
    const table = c.host.querySelector("table") as HTMLElement;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["", "A", "B", "C"]);
    const kwota = table.querySelectorAll("tbody tr")[1].querySelectorAll("td")[1];
    expect(kwota.textContent).toBe("12,50");
    expect(kwota.classList.contains("n")).toBe(true);
    expect(status).toHaveBeenCalledWith("Wierszy: 3, kolumn: 3");
    viewer.dispose();
    expect(c.host.children).toHaveLength(0);
  });

  it("plik ponad 20 MiB to too-large", async () => {
    const big = new ArrayBuffer(20 * 1024 * 1024 + 1);
    const err = await createCsvViewer().open(big, ctx("duzy.csv", big.byteLength)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewError);
    expect((err as PreviewError).code).toBe("too-large");
  });
});
