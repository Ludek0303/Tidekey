import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitLgpl } from "../vite-lgpl";
import { lgplAssetPath, lgplUrl } from "./lgpl";

const VENDOR = resolve(import.meta.dirname, "../../../vendor/lgpl");
const PKG_DIR = "libheif-js-1.23.5";

// published name -> file in vendor/lgpl/libheif-js-1.23.5
const PUBLISHED: [string, string][] = [
  ["assets/lgpl-libheif-js-1.23.5-libheif.js", "libheif.js"],
  ["assets/lgpl-libheif-js-1.23.5-libheif.wasm", "libheif.wasm"],
  ["assets/lgpl-libheif-js-1.23.5-LICENSE.txt", "LICENSE"],
];

interface Emitted {
  fileName: string;
  source: Uint8Array;
}

// Runs the plugin's build step on `root`; a failed check throws the message the build would show.
function build(root: string): Emitted[] {
  const out: Emitted[] = [];
  emitLgpl(
    {
      emitFile: (file) => {
        out.push({ fileName: file.fileName, source: file.source });
        return "";
      },
      error: (message) => {
        throw new Error(message);
      },
    },
    root,
  );
  return out;
}

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("vite-lgpl: pliki LGPL w budowie podglądu", () => {
  it("emituje trzy pliki o bajtach identycznych z vendor/lgpl pod nazwami z kontraktu", () => {
    const files = build(VENDOR);
    expect(files.map((f) => f.fileName).sort()).toEqual(PUBLISHED.map(([name]) => name).sort());
    for (const [name, file] of PUBLISHED) {
      const emitted = files.find((f) => f.fileName === name);
      expect(emitted, name).toBeDefined();
      expect(Buffer.from(emitted!.source).equals(readFileSync(join(VENDOR, PKG_DIR, file)))).toBe(true);
    }
  });

  it("zmieniony bajt w kopii przerywa budowę z nazwą pliku", () => {
    tmp = mkdtempSync(join(tmpdir(), "lgpl-"));
    cpSync(VENDOR, tmp, { recursive: true });
    const wasm = join(tmp, PKG_DIR, "libheif.wasm");
    const bytes = readFileSync(wasm);
    bytes[1000] ^= 0x01;
    writeFileSync(wasm, bytes);
    expect(() => build(tmp!)).toThrow(/libheif\.wasm/);
  });
});

describe("lgpl: adresy plików w ramce", () => {
  it("skrypt libheif jest pod /preview/assets/ z nazwą z kontraktu", () => {
    expect(lgplUrl("libheif")).toBe("/preview/assets/lgpl-libheif-js-1.23.5-libheif.js");
  });

  it("plik wasm libheif jest ścieżką zasobu, o którą pyta przeglądarka", () => {
    expect(lgplAssetPath("libheif", "libheif.wasm")).toBe("assets/lgpl-libheif-js-1.23.5-libheif.wasm");
  });
});
