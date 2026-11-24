import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateTable, initFormula } from "./formula";

// Node has no fetch for file: URLs, so init reads the real .wasm through a stubbed fetch.
beforeAll(async () => {
  const bytes = readFileSync(resolve(__dirname, "wasm/notes_web_bg.wasm"));
  vi.stubGlobal(
    "fetch",
    async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }),
  );
  await initFormula();
  vi.unstubAllGlobals();
});

const EXAMPLE = `| Zadanie | Start | Koniec | Dni |
|---|---|---|---|
| Projekt | 2026-10-01 | 2026-10-19 | =C2-B2 |
| Testy | 19.10.2026 | =B3+14 | =C3-B3 |
| **Razem** | | | =SUMA(D2:D3) |`;

describe("formula wasm bridge", () => {
  it("evaluates the spec example table (§4.16a)", () => {
    const t = evaluateTable(EXAMPLE, new Date(2026, 9, 19));
    expect(t).not.toBeNull();
    expect(t!.cell(1, 3).text).toBe("18");
    expect(t!.cell(2, 2).text).toBe("02.11.2026");
    expect(t!.cell(2, 2).kind).toBe("date");
    expect(t!.cell(2, 3).text).toBe("14");
    expect(t!.cell(3, 3).text).toBe("32");
    expect(t!.cell(3, 3).isFormula).toBe(true);
    expect(t!.cell(1, 1).isFormula).toBe(false);
    expect(t!.cell(99, 0).text).toBe("");
  });

  it("returns null for text that is not a table", () => {
    expect(evaluateTable("zwykły tekst")).toBeNull();
    expect(evaluateTable("| a | b |")).toBeNull();
  });

  it("keeps an escaped pipe inside [[...]] as one cell", () => {
    const t = evaluateTable("| a | b |\n|---|---|\n| [[x\\|y]] | z |");
    expect(t!.rows).toBe(2);
    expect(t!.cols).toBe(2);
    expect(t!.cell(1, 0).text).toBe("[[x|y]]");
  });

  it("uses the given day for DZIŚ", () => {
    const t = evaluateTable("| d | x |\n|---|---|\n| 2026-10-01 | =DZIŚ()-A2 |", new Date(2026, 9, 19));
    expect(t!.cell(1, 1).text).toBe("18");
  });

  it("evaluates 1000 rows in under 50 ms including the JS copy", () => {
    const lines = ["| n | v |", "|---|---|"];
    for (let k = 0; k < 1000; k++) lines.push(`| ${k} | =${k}*2 |`);
    const md = lines.join("\n");
    evaluateTable(md); // warm-up, so the timing is not the first-call cost
    const start = performance.now();
    const t = evaluateTable(md);
    const ms = performance.now() - start;
    expect(t!.rows).toBe(1001);
    expect(t!.cell(1000, 1).text).toBe("1998");
    expect(ms).toBeLessThan(50);
  });
});
