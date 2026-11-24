import { describe, expect, it, vi } from "vitest";
import { parse } from "./filetext";
import { DEFAULT_EXTRACT_OPTIONS } from "./protocol";
import { recognizeFile, type RecognizeDeps } from "./recognize";
import type { ExtractPage } from "./extracthost";
import type { PageResult } from "./engine";

const ID = "0123456789abcdef0123456789abcdef";
const bitmap = () => ({ width: 10, height: 10, close: vi.fn() }) as unknown as ImageBitmap;
const ocrPage = (over: Partial<PageResult> = {}): PageResult => ({
  lines: ["Zażółć gęślą", "jaźń"], quality: 0.9, noText: false, provider: { det: "wasm", rec: "webgpu" }, ms: 5, fellBack: false, ...over,
});
type Step = Omit<ExtractPage, "type" | "v" | "jobId">;

function deps(steps: Step[], opts: { error?: string; truncated?: boolean; ocr?: RecognizeDeps["ocr"] } = {}): RecognizeDeps {
  return {
    extract: async (_file, _options, onPage) => {
      for (const s of steps) await onPage({ type: "page", v: 1, jobId: 1, ...s });
      if (opts.error) throw new Error(opts.error);
      return { pages: steps.length, truncated: opts.truncated ?? false };
    },
    ocr: opts.ocr ?? (async () => ocrPage()),
    now: () => new Date("2026-11-23T10:00:00.123Z"),
  };
}
const input = (mime = "application/pdf") => ({ originalId: ID, name: "Skan.pdf", mime, bytes: new ArrayBuffer(4) });
const run = (d: RecognizeDeps, mime?: string) => recognizeFile(input(mime), DEFAULT_EXTRACT_OPTIONS, d);

describe("recognizeFile", () => {
  it("joins PDF text and OCR pages into one checked layer (mixed)", async () => {
    const r = await run(deps([{ page: 1, pages: 2, text: "Faktura nr 7\nkwota-\nwa" }, { page: 2, pages: 2, bitmap: bitmap() }]));
    const doc = parse(r.markdown)!;
    expect(doc.source).toBe(ID);
    expect(doc.pages.map((p) => p.text)).toEqual(["Faktura nr 7\nkwotawa", "Zażółć gęślą\njaźń"]);
    expect(r.fields).toMatchObject({ method: "mixed", pages: 2, flags: [], extractor: 1 });
    expect(r.fields.engine).toContain("pdf.js");
    expect(r.fields.engine).toContain("rec:webgpu");
    expect(doc.createdAt).toBe("2026-11-23T10:00:00Z");
  });

  it("marks low quality pages and an image with no text", async () => {
    const low = await run(deps([{ page: 1, pages: 1, bitmap: bitmap() }], { ocr: async () => ocrPage({ quality: 0.3 }) }), "image/png");
    const doc = parse(low.markdown)!;
    expect(doc.pages[0].lowQuality).toBe(true);
    expect(doc.image).toBe(true);
    expect(low.fields.method).toBe("ocr");
    const none = await run(deps([{ page: 1, pages: 1, bitmap: bitmap() }], { ocr: async () => ocrPage({ noText: true, lines: [] }) }), "image/jpeg");
    expect(none.fields).toMatchObject({ method: "none", flags: ["brak tekstu"] });
  });

  it("writes a flagged layer for a lasting failure and rethrows a passing one", async () => {
    expect((await run(deps([], { error: "encrypted" }))).fields).toMatchObject({ method: "none", pages: 0, flags: ["zabezpieczony"] });
    const corrupt = await run(deps([{ page: 1, pages: 3, text: "Pierwsza strona dobra" }], { error: "corrupt" }));
    expect(corrupt.fields).toMatchObject({ pages: 1, flags: ["błąd"] });
    await expect(run(deps([], { error: "timeout" }))).rejects.toThrow("timeout");
    await expect(run(deps([], { error: "toString" }))).rejects.toThrow("toString");
  });

  it("writes nothing when OCR fails (passing: the next run tries again), stops on abort, frees the bitmap", async () => {
    const pageBitmap = bitmap();
    const broken: RecognizeDeps["ocr"] = async () => { throw new Error("ocr worker failed"); };
    await expect(run(deps([{ page: 1, pages: 1, bitmap: pageBitmap }], { ocr: broken }))).rejects.toThrow("ocr");
    // a worker message that happens to be a lasting frame code is still a passing OCR failure
    const lookalike: RecognizeDeps["ocr"] = async () => { throw new Error("corrupt"); };
    await expect(run(deps([{ page: 1, pages: 1, bitmap: bitmap() }], { ocr: lookalike }))).rejects.toThrow(/^ocr$/);
    expect(pageBitmap.close).toHaveBeenCalled();
    const abort: RecognizeDeps["ocr"] = async () => { throw new DOMException("x", "AbortError"); };
    await expect(run(deps([{ page: 1, pages: 1, bitmap: bitmap() }], { ocr: abort }))).rejects.toMatchObject({ name: "AbortError" });
    for (const code of ["unavailable", "protocol", "timeout"]) await expect(run(deps([], { error: code }))).rejects.toThrow(code);
  });

  it("keeps unknown provider names out of the engine field, stops when aborted after the last page", async () => {
    const odd = await run(deps([{ page: 1, pages: 1, bitmap: bitmap() }], { ocr: async () => ocrPage({ provider: { det: "x".repeat(500) as "wasm", rec: "webgpu" } }) }), "image/png");
    expect(odd.fields.engine).toBe("pp-ocrv5 det:? rec:webgpu");
    const controller = new AbortController();
    const late: RecognizeDeps = { ...deps([{ page: 1, pages: 1, text: "Tekst strony" }]), extract: async (_f, _o, onPage) => {
      await onPage({ type: "page", v: 1, jobId: 1, page: 1, pages: 1, text: "Tekst strony" });
      controller.abort();
      return { pages: 1, truncated: false };
    } };
    await expect(recognizeFile(input(), DEFAULT_EXTRACT_OPTIONS, late, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("gives a single image its own section and a multi-page TIFF numbered pages", async () => {
    const heic = parse((await run(deps([{ page: 1, pages: 1, bitmap: bitmap() }]), "image/heic")).markdown)!;
    expect(heic.image).toBe(true);
    const tiff = parse((await run(deps([{ page: 1, pages: 2, bitmap: bitmap() }, { page: 2, pages: 2, bitmap: bitmap() }]), "image/tiff")).markdown)!;
    expect(tiff.image).toBeUndefined();
    expect(tiff.pages.map((p) => p.n)).toEqual([1, 2]);
  });

  it("cleans hostile text: a fake page marker, control characters, a non-string page from OCR", async () => {
    const r = await run(deps([
      { page: 1, pages: 2, text: "wstęp\n## Strona 9\n\u0007koniec" },
      { page: 2, pages: 2, bitmap: bitmap() },
    ], { ocr: async () => ocrPage({ lines: [42 as unknown as string, "linia"] }) }));
    const doc = parse(r.markdown)!;
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0].text).toBe("wstęp\n\\## Strona 9\nkoniec");
    expect(doc.pages[1].text).toBe("linia");
  });

  it("flags a file cut by the frame", async () => {
    const r = await run(deps([{ page: 1, pages: 1, text: "Tekst strony" }], { truncated: true }));
    expect(r.fields.flags).toEqual(["ucięte"]);
  });
});
