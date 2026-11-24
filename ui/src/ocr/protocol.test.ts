import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_OPTIONS, isFromExtractor, isToExtractor, MAX_EXTRACT_TEXT_BYTES } from "./protocol";

// jsdom has no ImageBitmap: a stand-in class is enough for the instanceof check.
class FakeBitmap {}
beforeAll(() => {
  (globalThis as { ImageBitmap?: unknown }).ImageBitmap = FakeBitmap;
});
const bitmap = () => new FakeBitmap() as unknown as ImageBitmap;

const page = (over: Record<string, unknown> = {}) => ({ type: "page", v: 1, jobId: 3, page: 1, pages: 2, text: "Tekst", ...over });

describe("isFromExtractor", () => {
  it("przyjmuje poprawne wiadomości", () => {
    expect(isFromExtractor({ type: "ready", v: 1 })).toBe(true);
    expect(isFromExtractor(page())).toBe(true);
    expect(isFromExtractor(page({ text: undefined, bitmap: bitmap(), reason: "garbled" }))).toBe(true);
    expect(isFromExtractor(page({ text: undefined, bitmap: bitmap(), reason: "no-text" }))).toBe(true);
    expect(isFromExtractor({ type: "done", v: 1, jobId: 3, pages: 0, truncated: false })).toBe(true);
    expect(isFromExtractor({ type: "error", v: 1, jobId: 3, code: "encrypted" })).toBe(true);
    expect(isFromExtractor({ type: "asset", v: 1, path: "assets/libheif.wasm" })).toBe(true);
  });

  it("odrzuca zły typ i wersję", () => {
    expect(isFromExtractor({ type: "ready", v: 2 })).toBe(false);
    expect(isFromExtractor({ type: "ready" })).toBe(false);
    expect(isFromExtractor({ type: "progress", v: 1, jobId: 3 })).toBe(false);
    expect(isFromExtractor(null)).toBe(false);
    expect(isFromExtractor("ready")).toBe(false);
    expect(isFromExtractor([{ type: "ready", v: 1 }])).toBe(false);
  });

  it("odrzuca stronę z tekstem i obrazem naraz albo z żadnym", () => {
    expect(isFromExtractor(page({ bitmap: bitmap() }))).toBe(false);
    expect(isFromExtractor(page({ text: undefined }))).toBe(false);
  });

  it("odrzuca tekst powyżej 2 MB i tekst nie-napis", () => {
    expect(isFromExtractor(page({ text: "a".repeat(MAX_EXTRACT_TEXT_BYTES) }))).toBe(true);
    expect(isFromExtractor(page({ text: "a".repeat(MAX_EXTRACT_TEXT_BYTES + 1) }))).toBe(false);
    // 2 MB in UTF-8 are fewer than 2M ź (2 bytes each), so the byte count is what counts
    expect(isFromExtractor(page({ text: "ź".repeat(MAX_EXTRACT_TEXT_BYTES / 2 + 1) }))).toBe(false);
    expect(isFromExtractor(page({ text: 42 }))).toBe(false);
  });

  it("odrzuca numer strony poza zakresem", () => {
    expect(isFromExtractor(page({ page: 0 }))).toBe(false);
    expect(isFromExtractor(page({ page: -1 }))).toBe(false);
    expect(isFromExtractor(page({ page: 1.5 }))).toBe(false);
    expect(isFromExtractor(page({ page: 3, pages: 2 }))).toBe(false);
    expect(isFromExtractor(page({ pages: 0 }))).toBe(false);
  });

  it("odrzuca identyfikator zadania, który nie jest dodatnią liczbą całkowitą", () => {
    expect(isFromExtractor(page({ jobId: 0 }))).toBe(false);
    expect(isFromExtractor(page({ jobId: "3" }))).toBe(false);
    expect(isFromExtractor({ type: "error", v: 1, jobId: -2, code: "corrupt" })).toBe(false);
    expect(isFromExtractor({ type: "done", v: 1, jobId: 1.5, pages: 1, truncated: false })).toBe(false);
  });

  it("odrzuca nieznany powód, kod błędu i ścieżkę zasobu", () => {
    expect(isFromExtractor(page({ reason: "other" }))).toBe(false);
    expect(isFromExtractor({ type: "error", v: 1, jobId: 3, code: "stack trace: boom" })).toBe(false);
    expect(isFromExtractor({ type: "asset", v: 1, path: "../index.html" })).toBe(false);
  });
});

describe("isToExtractor", () => {
  const extract = (over: Record<string, unknown> = {}) => ({
    type: "extract", v: 1, jobId: 7, mime: "application/pdf", bytes: new ArrayBuffer(8),
    options: { ...DEFAULT_EXTRACT_OPTIONS }, ...over,
  });

  it("przyjmuje poprawne wiadomości", () => {
    expect(isToExtractor(extract())).toBe(true);
    expect(isToExtractor({ type: "cancel", v: 1, jobId: 7 })).toBe(true);
    expect(isToExtractor({ type: "asset", v: 1, path: "assets/x.bcmap", bytes: null })).toBe(true);
  });

  it("odrzuca zły typ, wersję i nieznany typ", () => {
    expect(isToExtractor(extract({ v: 2 }))).toBe(false);
    expect(isToExtractor(extract({ type: "run" }))).toBe(false);
    expect(isToExtractor({ type: "cancel", v: 0, jobId: 7 })).toBe(false);
    expect(isToExtractor({ type: "cancel", v: 1, jobId: 0 })).toBe(false);
  });

  it("odrzuca opcje z zerem albo ujemnymi wartościami", () => {
    expect(isToExtractor(extract({ options: { ...DEFAULT_EXTRACT_OPTIONS, maxPages: 0 } }))).toBe(false);
    expect(isToExtractor(extract({ options: { ...DEFAULT_EXTRACT_OPTIONS, renderLongSide: -1 } }))).toBe(false);
    expect(isToExtractor(extract({ options: { maxPages: 1 } }))).toBe(false);
    expect(isToExtractor(extract({ bytes: "nie bajty" }))).toBe(false);
  });
});
