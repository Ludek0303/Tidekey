import { describe, expect, it } from "vitest";
import { assetPathOf } from "./previewwasm";

describe("assetPathOf", () => {
  it("drops the frame's /preview/ prefix", () => {
    expect(assetPathOf("/preview/assets/notes_preview_bg.wasm")).toBe("assets/notes_preview_bg.wasm");
  });

  it("keeps the hash Vite puts in the file name", () => {
    expect(assetPathOf("/preview/assets/notes_preview_bg-AbC1.wasm")).toBe("assets/notes_preview_bg-AbC1.wasm");
  });

  it("refuses an address outside /preview/", () => {
    expect(() => assetPathOf("/assets/notes_preview_bg.wasm")).toThrow();
    expect(() => assetPathOf("https://example.com/preview/assets/x.wasm")).toThrow();
    expect(() => assetPathOf("/preview/")).toThrow();
  });
});
