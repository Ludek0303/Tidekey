// @vitest-environment node
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { classicWorkerSource } from "./pdfworker";

const WORKER = new URL("../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url);

describe("classicWorkerSource", () => {
  it("usuwa końcowy eksport, także z białymi znakami i bez średnika", () => {
    expect(classicWorkerSource("a();export{WorkerMessageHandler};\n")).toBe("a();");
    expect(classicWorkerSource("a();export { WorkerMessageHandler }  ")).toBe("a();");
  });

  it("zamienia każde import.meta.url", () => {
    expect(classicWorkerSource("x=import.meta.url;y=import.meta.url;")).toBe("x=self.location.href;y=self.location.href;");
  });

  it("nie rusza niczego poza tym", () => {
    const plain = "let v = 1; import.meta.resolve; export{WorkerMessageHandler};x";
    expect(classicWorkerSource(plain)).toBe(plain);
  });

  it("pdf.worker.min.mjs: bez import.meta i eksportu, kompiluje się jako skrypt klasyczny", () => {
    const out = classicWorkerSource(readFileSync(WORKER, "utf8"));
    expect(out).not.toContain("import.meta");
    expect(out).not.toMatch(/export\s*\{/);
    expect(out).toContain("self.location.href");
    expect(out.trimEnd().endsWith("globalThis.pdfjsWorker={WorkerMessageHandler};")).toBe(true);
    expect(() => new Script(out)).not.toThrow();
  });
});
