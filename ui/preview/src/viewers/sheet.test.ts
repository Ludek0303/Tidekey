// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { PreviewError, type ViewerContext } from "./index";
import { createSheetViewer, MAX_COLS, MAX_ROWS, readSheets } from "./sheet";
import type { Theme } from "../../../src/preview/protocol";

const FIXTURES = resolve(import.meta.dirname, "../../../../fixtures/preview");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

const DEFAULT_THEME: Theme = {
  name: "dark",
  colors: { bg: "#161719", panel: "#1e1f22", text: "#ececf0", muted: "#a6a6b2", accent: "#b4a0ff", border: "#35363c" },
};

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PreviewError) return err.code;
    throw err;
  }
  return "no error";
}

function xlsxBytes(book: XLSX.WorkBook): Uint8Array {
  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

describe("readSheets: xlsx", () => {
  const sheets = readSheets(fixture("arkusz.xlsx"));

  it("dwa arkusze w kolejności z pliku", () => {
    expect(sheets.map((s) => s.name)).toEqual(["Plan", "Wykonanie"]);
  });

  it("kwota z formatem liczby i waluty, a nie surowa liczba", () => {
    const plan = sheets[0];
    expect(plan.rows[2][2]).toBe("4,500.00 zł");
    expect(plan.rows[3][2]).toBe("1,890.50 zł");
    expect(plan.numeric[2][2]).toBe(true);
  });

  it("data pokazana jako tekst daty, nie jako numer seryjny", () => {
    expect(sheets[0].rows[2][1]).toBe("01/03/2026");
    expect(sheets[0].rows[2][1]).not.toBe("46082");
  });

  it("scalenia z arkusza", () => {
    expect(sheets[0].merges).toEqual([
      { r: 0, c: 0, rows: 1, cols: 4 },
      { r: 6, c: 0, rows: 1, cols: 2 },
    ]);
  });

  it("wynik formuły SUM jako liczba sformatowana", () => {
    expect(sheets[0].rows[6][2]).toBe("7,951.25 zł");
    expect(sheets[0].numeric[6][2]).toBe(true);
  });

  it("zapisany wynik formuły z drugiego arkusza, bez ponownego liczenia", () => {
    expect(sheets[1].rows[2][2]).toBe("4,140.00 zł");
    expect(sheets[1].rows[0][0]).toBe("Wykonanie 2026");
  });

  it("zakres z !ref: rowCount i colCount", () => {
    expect(sheets[0].rowCount).toBe(7);
    expect(sheets[0].colCount).toBe(4);
    expect(sheets[0].rows).toHaveLength(7);
    expect(sheets[0].rows[0]).toHaveLength(4);
  });
});

describe("readSheets: xls i ods", () => {
  const xlsx = readSheets(fixture("arkusz.xlsx"));

  it("xls: te same nazwy i te same wartości", () => {
    const xls = readSheets(fixture("arkusz.xls"));
    expect(xls.map((s) => s.name)).toEqual(["Plan", "Wykonanie"]);
    expect(xls.map((s) => s.rows)).toEqual(xlsx.map((s) => s.rows));
  });

  it("ods: te same nazwy arkuszy i te same liczby", () => {
    const ods = readSheets(fixture("arkusz.ods"));
    expect(ods.map((s) => s.name)).toEqual(["Plan", "Wykonanie"]);
    expect(ods[0].rows[0][0]).toBe("Plan finansowy 2026");
    expect(ods[0].rows[1]).toEqual(xlsx[0].rows[1]);
    expect(ods[0].rows[6][2]).toMatch(/^7\s951,25 zł$/);
    expect(ods[0].numeric[6][2]).toBe(true);
    expect(ods[0].merges).toEqual(xlsx[0].merges);
  });
});

describe("readSheets: błędy i limity", () => {
  it("losowe bajty to corrupt", () => {
    const junk = new Uint8Array(4000).map((_, i) => (i * 37 + 11) % 251);
    expect(errorCode(() => readSheets(junk))).toBe("corrupt");
  });

  it("obcięty xlsx to corrupt", () => {
    const whole = fixture("arkusz.xlsx");
    expect(errorCode(() => readSheets(whole.subarray(0, whole.length >> 1)))).toBe("corrupt");
  });

  it("ZIP deklarujący ponad 300 MiB po rozpakowaniu to too-large", () => {
    // A ZIP whose central directory declares one entry of 301 MiB; no entry data is needed for the check.
    const name = new TextEncoder().encode("xl/bomba.xml");
    const buf = new Uint8Array(46 + name.length + 22);
    const v = new DataView(buf.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint32(24, 301 * 1024 * 1024, true);
    v.setUint16(28, name.length, true);
    buf.set(name, 46);
    const eocd = 46 + name.length;
    v.setUint32(eocd, 0x06054b50, true);
    v.setUint16(eocd + 8, 1, true);
    v.setUint16(eocd + 10, 1, true);
    v.setUint32(eocd + 12, 46 + name.length, true);
    v.setUint32(eocd + 16, 0, true);
    expect(errorCode(() => readSheets(buf))).toBe("too-large");
  });

  it("arkusz z 3000 wierszy: 2000 pokazanych, rowCount 3000", () => {
    const aoa = Array.from({ length: 3000 }, (_, i) => [i, `wiersz ${i}`]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), "Duży");
    const [sheet] = readSheets(xlsxBytes(book));
    expect(MAX_ROWS).toBe(2000);
    expect(MAX_COLS).toBe(200);
    expect(sheet.rows).toHaveLength(MAX_ROWS);
    expect(sheet.rowCount).toBe(3000);
    expect(sheet.colCount).toBe(2);
    expect(sheet.rows[1999][1]).toBe("wiersz 1999");
  });

  it("więcej niż 2 000 000 pokazanych komórek to too-large", () => {
    // Sparse sheets: a declared range of 2000 x 200 with one cell each, so the test stays small.
    const book = XLSX.utils.book_new();
    for (let i = 0; i < 6; i++) {
      const ws: XLSX.WorkSheet = { A1: { t: "s", v: `arkusz ${i}` }, "!ref": `A1:GR${MAX_ROWS}` };
      XLSX.utils.book_append_sheet(book, ws, `S${i}`);
    }
    expect(errorCode(() => readSheets(xlsxBytes(book)))).toBe("too-large");
  });

  it("arkusze ukryte są pomijane, a najwyżej 100 arkuszy zostaje", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["ukryty"]]), "Ukryty");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["widoczny"]]), "Widoczny");
    book.Workbook = { Sheets: [{ name: "Ukryty", Hidden: 1 }, { name: "Widoczny", Hidden: 0 }] };
    expect(readSheets(xlsxBytes(book)).map((s) => s.name)).toEqual(["Widoczny"]);

    const many = XLSX.utils.book_new();
    for (let i = 0; i < 101; i++) XLSX.utils.book_append_sheet(many, XLSX.utils.aoa_to_sheet([[i]]), `S${i}`);
    const sheets = readSheets(xlsxBytes(many));
    expect(sheets).toHaveLength(100);
    expect(sheets[99].name).toBe("S99");
  });
});

describe("createSheetViewer", () => {
  const status = vi.fn<(text: string) => void>();
  const ctx = (name: string, mime: string): ViewerContext => ({
    host: document.createElement("div"),
    name,
    mime,
    size: 0,
    signal: new AbortController().signal,
    theme: DEFAULT_THEME,
    asset: async () => new ArrayBuffer(0),
    spawnWorker: async () => null,
    status,
    nav: () => undefined,
  });
  const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
  const key = (k: string, ctrlKey = false): KeyboardEvent => new KeyboardEvent("keydown", { key: k, ctrlKey });

  it("siatka z zakładkami; przełączenie rysuje arkusz od nowa; klawisze", async () => {
    const c = ctx("arkusz.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const viewer = createSheetViewer();
    await viewer.open(buffer(fixture("arkusz.xlsx")), c);

    const tabs = [...c.host.querySelectorAll('[role="tablist"][aria-label="Arkusze"] [role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Plan", "Wykonanie"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(c.host.querySelector("tbody tr td")?.textContent).toBe("Plan finansowy 2026");
    expect(status).toHaveBeenLastCalledWith("Arkusz: Plan, wierszy: 7");

    expect(viewer.key?.(key("PageDown", true))).toBe(true);
    expect(c.host.querySelector("tbody tr td")?.textContent).toBe("Wykonanie 2026");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(status).toHaveBeenLastCalledWith("Arkusz: Wykonanie, wierszy: 7");

    expect(viewer.key?.(key("PageUp", true))).toBe(true);
    expect(c.host.querySelector("tbody tr td")?.textContent).toBe("Plan finansowy 2026");
    expect(viewer.key?.(key("ArrowRight"))).toBe(false);
    expect(viewer.key?.(key("ArrowLeft"))).toBe(false);

    viewer.dispose();
    expect(c.host.children).toHaveLength(0);
  });

  it("plik, który nie jest arkuszem, zgłasza błąd bez rysowania", async () => {
    const c = ctx("zepsuty.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const junk = new Uint8Array(100).fill(7);
    const err = await createSheetViewer().open(buffer(junk), c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewError);
    expect((err as PreviewError).code).toBe("corrupt");
    expect(c.host.children).toHaveLength(0);
  });

  it("pasek „Pokazano…” gdy arkusz jest obcięty", async () => {
    const aoa = Array.from({ length: 3000 }, (_, i) => [i]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), "Duży");
    const c = ctx("duzy.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await createSheetViewer().open(buffer(xlsxBytes(book)), c);
    const pl = (n: number): string => n.toLocaleString("pl-PL");
    expect(c.host.querySelector(".siatka-uwaga")?.textContent).toBe(`Pokazano ${pl(2000)} z ${pl(3000)} wierszy.`);
  });
});
