import { describe, expect, it } from "vitest";
import { ASSET_PATH, MAX_BYTES, MAX_TEXT, MAX_THUMB_SIDE, PROTOCOL_VERSION, parseFromFrame, parseToFrame } from "./protocol";

const colors = { bg: "#101010", panel: "#1a1a1a", text: "#eeeeee", muted: "#888888", accent: "#3366ff", border: "#333333" };
const theme = { name: "dark", colors };
const buf = (n = 4): ArrayBuffer => new ArrayBuffer(n);
const pixels = (w: number, h: number): ArrayBuffer => new ArrayBuffer(w * h * 4);
// An ArrayBuffer whose byteLength reports `n`, without allocating `n` bytes.
function withByteLength(n: number): ArrayBuffer {
  const b = new ArrayBuffer(8);
  Object.defineProperty(b, "byteLength", { value: n });
  return b;
}
const throwingGetter = (): unknown => ({
  get v(): number {
    throw new Error("boom");
  },
});
const throwingProxy = (): unknown =>
  new Proxy({}, {
    get(): never {
      throw new Error("boom");
    },
  });

describe("constants", () => {
  it("wartości z planu", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_TEXT).toBe(512);
    expect(MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_THUMB_SIDE).toBe(480);
    expect(ASSET_PATH.test("assets/a.wasm")).toBe(true);
  });
});

describe("parseToFrame: poprawne komunikaty", () => {
  const b = buf();
  const cases: Array<{ label: string; input: unknown; expected: Record<string, unknown> }> = [
    { label: "init", input: { v: 1, type: "init", theme }, expected: { v: 1, type: "init", theme } },
    {
      label: "open pełny",
      input: { v: 1, type: "open", id: 7, name: "a.pdf", mime: "application/pdf", size: 1024, viewer: "pdf", bytes: b, label: "first-frame", durationMs: 1500 },
      expected: { v: 1, type: "open", id: 7, name: "a.pdf", mime: "application/pdf", size: 1024, viewer: "pdf", bytes: b, label: "first-frame", durationMs: 1500 },
    },
    {
      label: "open minimalny",
      input: { v: 1, type: "open", id: 0, name: "x", mime: "", size: 0, viewer: "none", bytes: b },
      expected: { v: 1, type: "open", id: 0, name: "x", mime: "", size: 0, viewer: "none", bytes: b },
    },
    { label: "command", input: { v: 1, type: "command", id: 2, name: "fit" }, expected: { v: 1, type: "command", id: 2, name: "fit" } },
    {
      label: "frame",
      input: { v: 1, type: "frame", id: 3, name: "film.mp4", mime: "video/mp4", bytes: b },
      expected: { v: 1, type: "frame", id: 3, name: "film.mp4", mime: "video/mp4", bytes: b },
    },
    { label: "asset z bajtami", input: { v: 1, type: "asset", path: "assets/x.wasm", bytes: b }, expected: { v: 1, type: "asset", path: "assets/x.wasm", bytes: b } },
    { label: "asset null", input: { v: 1, type: "asset", path: "assets/x.wasm", bytes: null }, expected: { v: 1, type: "asset", path: "assets/x.wasm", bytes: null } },
    { label: "dispose", input: { v: 1, type: "dispose" }, expected: { v: 1, type: "dispose" } },
  ];

  it.each(cases)("$label przechodzi bez dodatkowych pól", ({ input, expected }) => {
    expect(parseToFrame(input)).toEqual(expected);
  });

  it("nieznane pola są pomijane, nie kopiowane", () => {
    const out = parseToFrame({ v: 1, type: "dispose", extra: { x: 1 }, evil: "y" });
    expect(Object.keys(out ?? {}).sort()).toEqual(["type", "v"]);
  });

  it("bytes to ten sam ArrayBuffer (bez kopiowania)", () => {
    const out = parseToFrame({ v: 1, type: "frame", id: 1, name: "a", mime: "", bytes: b });
    expect(out && "bytes" in out && out.bytes).toBe(b);
  });

  it("kolory: wielkie litery też dopuszczone, granica 512 znaków tekstu", () => {
    const upper = { ...colors, bg: "#ABCDEF" };
    expect(parseToFrame({ v: 1, type: "init", theme: { name: "light", colors: upper } })).toEqual({
      v: 1, type: "init", theme: { name: "light", colors: upper },
    });
    const name = "a".repeat(MAX_TEXT);
    expect(parseToFrame({ v: 1, type: "command", id: 0, name: "zoom-in" })).not.toBeNull();
    expect(parseToFrame({ v: 1, type: "open", id: 0, name, mime: "", size: 0, viewer: "none", bytes: b })).not.toBeNull();
  });
});

describe("parseFromFrame: poprawne komunikaty", () => {
  const frameWide = pixels(480, 1);
  const frameOne = pixels(1, 1);
  const cases: Array<{ label: string; input: unknown; expected: Record<string, unknown> }> = [
    { label: "ready", input: { v: 1, type: "ready" }, expected: { v: 1, type: "ready" } },
    {
      label: "progress preparing",
      input: { v: 1, type: "progress", id: 1, phase: "preparing" },
      expected: { v: 1, type: "progress", id: 1, phase: "preparing" },
    },
    {
      label: "progress shown ze statusem",
      input: { v: 1, type: "progress", id: 1, phase: "shown", status: "Strona 2 z 9" },
      expected: { v: 1, type: "progress", id: 1, phase: "shown", status: "Strona 2 z 9" },
    },
    { label: "error", input: { v: 1, type: "error", id: 4, code: "corrupt" }, expected: { v: 1, type: "error", id: 4, code: "corrupt" } },
    { label: "nav -1", input: { v: 1, type: "nav", dir: -1 }, expected: { v: 1, type: "nav", dir: -1 } },
    { label: "nav 1", input: { v: 1, type: "nav", dir: 1 }, expected: { v: 1, type: "nav", dir: 1 } },
    { label: "close", input: { v: 1, type: "close" }, expected: { v: 1, type: "close" } },
    { label: "download", input: { v: 1, type: "download" }, expected: { v: 1, type: "download" } },
    { label: "asset", input: { v: 1, type: "asset", path: "assets/a.b-c_d.wasm" }, expected: { v: 1, type: "asset", path: "assets/a.b-c_d.wasm" } },
    {
      label: "frame z durationMs",
      input: { v: 1, type: "frame", id: 2, width: 480, height: 1, pixels: frameWide, durationMs: 0 },
      expected: { v: 1, type: "frame", id: 2, width: 480, height: 1, pixels: frameWide, durationMs: 0 },
    },
    {
      label: "frame bez durationMs",
      input: { v: 1, type: "frame", id: 2, width: 1, height: 1, pixels: frameOne },
      expected: { v: 1, type: "frame", id: 2, width: 1, height: 1, pixels: frameOne },
    },
    { label: "frame-error", input: { v: 1, type: "frame-error", id: 2, code: "timeout" }, expected: { v: 1, type: "frame-error", id: 2, code: "timeout" } },
  ];

  it.each(cases)("$label przechodzi bez dodatkowych pól", ({ input, expected }) => {
    const out = parseFromFrame(input);
    expect(out).toMatchObject(expected);
    expect(Object.keys(out ?? {}).sort()).toEqual(Object.keys(expected).sort());
  });

  it("frame zachowuje ten sam bufor pikseli", () => {
    const px = pixels(2, 2);
    const out = parseFromFrame({ v: 1, type: "frame", id: 0, width: 2, height: 2, pixels: px });
    expect(out && "pixels" in out && out.pixels).toBe(px);
  });
});

// Reguły wspólne: błędne dane odrzucane przez obie strony.
const COMMON_INVALID: Array<{ label: string; input: unknown }> = [
  { label: "null", input: null },
  { label: "tablica", input: [] },
  { label: "napis", input: "x" },
  { label: "liczba", input: 42 },
  { label: "undefined", input: undefined },
  { label: "brak v", input: { type: "close" } },
  { label: "v: 2", input: { v: 2, type: "close" } },
  { label: "brak type", input: { v: 1 } },
  { label: "nieznany type", input: { v: 1, type: "nope" } },
  { label: "getter rzucający", input: throwingGetter() },
  { label: "proxy rzucający", input: throwingProxy() },
];

describe("parseToFrame: odrzuca błędne dane", () => {
  const TO_FRAME_INVALID: Array<{ label: string; input: unknown }> = [
    ...COMMON_INVALID,
    { label: "from-only type ready", input: { v: 1, type: "ready" } },
    { label: "open id -1", input: { v: 1, type: "open", id: -1, name: "a", mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "open id 1.5", input: { v: 1, type: "open", id: 1.5, name: "a", mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "open id NaN", input: { v: 1, type: "open", id: NaN, name: "a", mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "open id jako napis", input: { v: 1, type: "open", id: "1", name: "a", mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "open size -1", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: -1, viewer: "none", bytes: buf() } },
    { label: "open size ponad MAX_SAFE_INTEGER", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: Number.MAX_SAFE_INTEGER + 1, viewer: "none", bytes: buf() } },
    { label: "open pusta nazwa", input: { v: 1, type: "open", id: 1, name: "", mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "open nazwa 513 znaków", input: { v: 1, type: "open", id: 1, name: "a".repeat(513), mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "open nazwa nie-napis", input: { v: 1, type: "open", id: 1, name: 7, mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "open mime 513 znaków", input: { v: 1, type: "open", id: 1, name: "a", mime: "a".repeat(513), size: 0, viewer: "none", bytes: buf() } },
    { label: "open viewer nieznany", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "exe", bytes: buf() } },
    { label: "open bytes jako Uint8Array", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none", bytes: new Uint8Array(4) } },
    { label: "open bytes brak", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none" } },
    { label: "open bytes ponad MAX_BYTES", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none", bytes: withByteLength(MAX_BYTES + 1) } },
    { label: "open label x", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none", bytes: buf(), label: "x" } },
    { label: "open durationMs -1", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none", bytes: buf(), durationMs: -1 } },
    { label: "open durationMs ponad 1e9", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none", bytes: buf(), durationMs: 1e9 + 1 } },
    { label: "open durationMs NaN", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none", bytes: buf(), durationMs: NaN } },
    { label: "init kolor red", input: { v: 1, type: "init", theme: { name: "dark", colors: { ...colors, bg: "red" } } } },
    { label: "init kolor 5 cyfr", input: { v: 1, type: "init", theme: { name: "dark", colors: { ...colors, bg: "#12345" } } } },
    { label: "init kolor 7 cyfr", input: { v: 1, type: "init", theme: { name: "dark", colors: { ...colors, bg: "#1234567" } } } },
    { label: "init brak koloru", input: { v: 1, type: "init", theme: { name: "dark", colors: { ...colors, bg: undefined } } } },
    { label: "init theme.name blue", input: { v: 1, type: "init", theme: { name: "blue", colors } } },
    { label: "command nieznana nazwa", input: { v: 1, type: "command", id: 1, name: "zoom" } },
    { label: "command id -1", input: { v: 1, type: "command", id: -1, name: "fit" } },
    { label: "frame bez bytes", input: { v: 1, type: "frame", id: 1, name: "a", mime: "" } },
    { label: "frame pusta nazwa", input: { v: 1, type: "frame", id: 1, name: "", mime: "", bytes: buf() } },
    { label: "asset ../x.wasm", input: { v: 1, type: "asset", path: "../x.wasm", bytes: null } },
    { label: "asset assets/a/b.wasm", input: { v: 1, type: "asset", path: "assets/a/b.wasm", bytes: null } },
    { label: "asset 129 znaków", input: { v: 1, type: "asset", path: `assets/${"a".repeat(129)}`, bytes: null } },
    { label: "asset bytes undefined", input: { v: 1, type: "asset", path: "assets/x.wasm" } },
    { label: "asset bytes napis", input: { v: 1, type: "asset", path: "assets/x.wasm", bytes: "x" } },
  ];

  it.each(TO_FRAME_INVALID)("$label -> null", ({ input }) => {
    expect(parseToFrame(input)).toBeNull();
  });
});

describe("parseFromFrame: odrzuca błędne dane", () => {
  const FROM_FRAME_INVALID: Array<{ label: string; input: unknown }> = [
    ...COMMON_INVALID,
    { label: "to-only type open", input: { v: 1, type: "open", id: 1, name: "a", mime: "", size: 0, viewer: "none", bytes: buf() } },
    { label: "progress phase x", input: { v: 1, type: "progress", id: 1, phase: "x" } },
    { label: "progress id -1", input: { v: 1, type: "progress", id: -1, phase: "shown" } },
    { label: "progress status 513 znaków", input: { v: 1, type: "progress", id: 1, phase: "shown", status: "a".repeat(513) } },
    { label: "progress status nie-napis", input: { v: 1, type: "progress", id: 1, phase: "shown", status: 3 } },
    { label: "error code boom", input: { v: 1, type: "error", id: 1, code: "boom" } },
    { label: "error id 1.5", input: { v: 1, type: "error", id: 1.5, code: "corrupt" } },
    { label: "frame-error code boom", input: { v: 1, type: "frame-error", id: 1, code: "boom" } },
    { label: "nav dir 0", input: { v: 1, type: "nav", dir: 0 } },
    { label: "nav dir 2", input: { v: 1, type: "nav", dir: 2 } },
    { label: "nav dir napis", input: { v: 1, type: "nav", dir: "1" } },
    { label: "asset path ../x.wasm", input: { v: 1, type: "asset", path: "../x.wasm" } },
    { label: "asset path brak", input: { v: 1, type: "asset" } },
    { label: "frame width 481", input: { v: 1, type: "frame", id: 1, width: 481, height: 1, pixels: pixels(481, 1) } },
    { label: "frame width 0", input: { v: 1, type: "frame", id: 1, width: 0, height: 1, pixels: pixels(1, 1) } },
    { label: "frame height 1.5", input: { v: 1, type: "frame", id: 1, width: 1, height: 1.5, pixels: buf(6) } },
    { label: "frame pixels.byteLength inne", input: { v: 1, type: "frame", id: 1, width: 2, height: 2, pixels: buf(15) } },
    { label: "frame pixels jako Uint8Array", input: { v: 1, type: "frame", id: 1, width: 1, height: 1, pixels: new Uint8Array(4) } },
    { label: "frame durationMs -1", input: { v: 1, type: "frame", id: 1, width: 1, height: 1, pixels: pixels(1, 1), durationMs: -1 } },
    { label: "frame-error id -1", input: { v: 1, type: "frame-error", id: -1, code: "codec" } },
  ];

  it.each(FROM_FRAME_INVALID)("$label -> null", ({ input }) => {
    expect(parseFromFrame(input)).toBeNull();
  });

  it("granice: width 480 przechodzi, height 481 nie", () => {
    expect(parseFromFrame({ v: 1, type: "frame", id: 1, width: 480, height: 1, pixels: pixels(480, 1) })).not.toBeNull();
    expect(parseFromFrame({ v: 1, type: "frame", id: 1, width: 1, height: 481, pixels: pixels(1, 481) })).toBeNull();
  });

  it("granice: asset path 128 znaków przechodzi, 129 nie", () => {
    expect(parseFromFrame({ v: 1, type: "asset", path: `assets/${"a".repeat(128)}` })).not.toBeNull();
    expect(parseFromFrame({ v: 1, type: "asset", path: `assets/${"a".repeat(129)}` })).toBeNull();
  });

  it("granice: bytes równe MAX_BYTES przechodzi", () => {
    expect(parseToFrame({ v: 1, type: "frame", id: 1, name: "a", mime: "", bytes: withByteLength(MAX_BYTES) })).not.toBeNull();
  });

  it("granice: durationMs 1e9 przechodzi, status równy MAX_TEXT przechodzi", () => {
    expect(parseFromFrame({ v: 1, type: "progress", id: 0, phase: "shown", status: "a".repeat(MAX_TEXT) })).not.toBeNull();
    expect(parseToFrame({ v: 1, type: "open", id: 0, name: "a", mime: "", size: 0, viewer: "none", bytes: buf(), durationMs: 1e9 })).not.toBeNull();
  });

  it("close carries an optional space key and nothing else", () => {
    expect(parseFromFrame({ v: 1, type: "close", key: "space", extra: 1 })).toEqual({ v: 1, type: "close", key: "space" });
    expect(parseFromFrame({ v: 1, type: "close" })).toEqual({ v: 1, type: "close" });
    expect(parseFromFrame({ v: 1, type: "close", key: "Enter" })).toBeNull();
  });
});
