// Old Word files (.doc) as text on white sheets, without the layout (PODGLAD-PLAN §2.1). The parser is in Rust
// (crates/preview/src/doc.rs); this file checks its JSON and draws it. The helpers here are shared with ppt.ts.
import { previewWasm, type PreviewWasm } from "../previewwasm";
import { PreviewError, type Viewer, type ViewerContext } from "./index";
import "./legacyoffice.css";

const SHEET_PX = 794; // A4 at 96 dpi
const SHEET_GAP_PX = 16;
const MIN_SCALE = 0.1;

export type DocBlock = { kind: "p"; text: string } | { kind: "table"; rows: string[][] };
export type DocPage = DocBlock[];
type TableBlock = Extract<DocBlock, { kind: "table" }>;
interface Paragraph {
  text: string;
  kind: "normal" | "cell" | "page";
}

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function isList(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Runs one call of the preview WASM module. A code from the module is the PreviewError; a panic is corrupt. */
export async function wasmCall<T>(ctx: ViewerContext, call: (wasm: PreviewWasm) => T): Promise<T> {
  const wasm = await previewWasm(ctx.asset);
  try {
    return call(wasm);
  } catch (err) {
    // the module throws its error code as the message; a panic in WASM is a RuntimeError
    const code = err instanceof Error ? err.message : "";
    throw new PreviewError(code === "too-large" || code === "unsupported" ? code : "corrupt");
  }
}

const isKind = (x: unknown): x is Paragraph["kind"] => x === "normal" || x === "cell" || x === "page";

function paragraphsOf(json: string): Paragraph[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new PreviewError("corrupt");
  }
  if (!isObject(data) || !isList(data.paragraphs)) throw new PreviewError("corrupt");
  return data.paragraphs.map((p) => {
    if (!isObject(p) || typeof p.text !== "string" || !isKind(p.kind)) throw new PreviewError("corrupt");
    return { text: p.text, kind: p.kind };
  });
}

const hasText = (b: DocBlock): boolean => b.kind === "table" || b.text !== "";

/**
 * The parser gives one paragraph per cell, and an empty cell ends each table row. A row ends at the first empty cell,
 * so an empty cell in the middle of a row also ends it: the parser does not tell the two apart.
 * shortcut: an empty cell inside a row splits the row, upgrade when the parser reports row ends separately.
 * A "page" paragraph starts a new sheet. Sheets with no text are dropped.
 */
export function parseDocModel(json: string): DocPage[] {
  const pages: DocPage[] = [];
  let page: DocPage = [];
  let table: TableBlock | null = null;
  let row: string[] = [];

  const closeRow = (): void => {
    if (row.length === 0) return;
    if (!table) {
      table = { kind: "table", rows: [] };
      page.push(table);
    }
    table.rows.push(row);
    row = [];
  };

  for (const p of paragraphsOf(json)) {
    if (p.kind === "cell") {
      if (p.text === "") closeRow();
      else row.push(p.text);
      continue;
    }
    closeRow();
    table = null;
    if (p.text !== "") page.push({ kind: "p", text: p.text });
    if (p.kind === "page") {
      pages.push(page);
      page = [];
    }
  }
  closeRow();
  pages.push(page);
  return pages.filter((pg) => pg.some(hasText));
}

function countParagraphs(pages: DocPage[]): number {
  let n = 0;
  for (const page of pages) {
    for (const b of page) n += b.kind === "p" ? (b.text === "" ? 0 : 1) : b.rows.reduce((k, r) => k + r.length, 0);
  }
  return n;
}

/** The zoom that fits a sheet into the view with a gap on both sides; a sheet that fits is shown at 100%. */
function sheetScale(viewWidth: number): number {
  return Math.min(1, Math.max(MIN_SCALE, (viewWidth - 2 * SHEET_GAP_PX) / SHEET_PX));
}

function sheet(page: DocPage): HTMLElement {
  const s = el("section", "doc-kartka");
  for (const b of page) {
    if (b.kind === "p") {
      const p = el("p");
      p.textContent = b.text;
      s.append(p);
      continue;
    }
    const table = el("table");
    for (const r of b.rows) {
      const tr = el("tr");
      for (const c of r) {
        const td = el("td");
        td.textContent = c;
        tr.append(td);
      }
      table.append(tr);
    }
    s.append(table);
  }
  return s;
}

export function createDocViewer(): Viewer {
  let root: HTMLElement | null = null;
  let sheets: HTMLElement | null = null;

  const fit = (): void => {
    if (root && sheets) sheets.style.zoom = String(sheetScale(root.clientWidth));
  };

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const json = await wasmCall(ctx, (wasm) => wasm.docTextJson(new Uint8Array(bytes)));
      const pages = parseDocModel(json);
      if (ctx.signal.aborted) return;

      const frame = el("div", "r-doc");
      // focused, so that the space bar and the page keys scroll the sheets
      frame.tabIndex = 0;
      const note = el("p", "lo-uwaga");
      note.textContent = "Podgląd bez formatowania (stary format .doc).";
      const body = el("div", "doc-kartki");
      if (pages.length === 0) {
        const empty = el("div", "lo-pusty");
        empty.textContent = "Dokument jest pusty.";
        frame.append(note, empty);
      } else {
        for (const page of pages) body.append(sheet(page));
        frame.append(note, body);
      }
      ctx.host.append(frame);
      root = frame;
      sheets = body;
      fit();
      ctx.status(`Akapitów: ${countParagraphs(pages)}`);
      frame.focus({ preventScroll: true });
    },

    resize(): void {
      fit();
    },

    key(e: KeyboardEvent): boolean {
      // the space bar closes the window only when the document does not fill the view (as in docx.ts)
      if (!root || e.ctrlKey || e.metaKey || e.altKey || root.scrollHeight <= root.clientHeight) return false;
      const step = root.clientHeight;
      if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) root.scrollBy({ top: step });
      else if (e.key === "PageUp" || (e.key === " " && e.shiftKey)) root.scrollBy({ top: -step });
      else return false;
      return true;
    },

    dispose(): void {
      root?.remove();
      root = null;
      sheets = null;
    },
  };
}
