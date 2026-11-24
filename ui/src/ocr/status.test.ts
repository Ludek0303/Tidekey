// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { on } from "../bus";
import { badgeText, hardwareLine, ocrBoard, statusOfLayer, isRecognizable } from "./status";

beforeEach(() => ocrBoard.reset());

describe("OCR status", () => {
  it("reads the status from the flags first, then the method", () => {
    expect(statusOfLayer({ flags: ["zabezpieczony"], method: "none" })).toBe("zabezpieczony");
    expect(statusOfLayer({ flags: ["błąd"], method: "ocr" })).toBe("błąd");
    expect(statusOfLayer({ flags: ["brak tekstu"], method: "ocr" })).toBe("brak tekstu");
    expect(statusOfLayer({ flags: [], method: "none" })).toBe("brak tekstu");
    expect(statusOfLayer({ flags: ["ucięte"], method: "mixed" })).toBe("tekst");
  });

  it("says which page a running file is on", () => {
    expect(badgeText("rozpoznawanie", { page: 3, pages: 12 })).toBe("rozpoznawanie s. 3 z 12");
    expect(badgeText("tekst")).toBe("rozpoznany");
  });

  it("recognizes the supported types only", () => {
    expect(isRecognizable("image/heic")).toBe(true);
    expect(isRecognizable("text/plain")).toBe(false);
  });

  it("keeps one status per file and announces it on the bus, progress apart", () => {
    const seen: string[] = [];
    const off = on("ocr:status", () => seen.push("status"));
    ocrBoard.set("a".repeat(32), "w kolejce");
    ocrBoard.set("a".repeat(32), "rozpoznawanie");
    ocrBoard.setProgress("a".repeat(32), 2, 5);
    expect(ocrBoard.running()).toBe("a".repeat(32));
    expect(ocrBoard.progressOf("a".repeat(32))).toEqual({ page: 2, pages: 5 });
    ocrBoard.set("a".repeat(32), "tekst");
    expect(ocrBoard.progressOf("a".repeat(32))).toBeUndefined();
    off();
    expect(seen).toEqual(["status", "status", "status"]);
  });

  it("writes the measurement line in Polish", () => {
    expect(hardwareLine({ det: "webgpu", rec: "wasm", msPerPage: 300 })).toBe("Wykrywanie: karta graficzna, rozpoznawanie: procesor, ok. 0,3 s na stronę");
    expect(hardwareLine(null)).toBe("");
  });
});
