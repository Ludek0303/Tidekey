// Guards against DOM globals that type-check silently: `self`, `top`, `parent`, `opener` and `event` exist on `window`,
// so a lost local declaration (vaults.ts once read the always-truthy `window.self`) compiles and misbehaves.
// shortcut: a lexical scan, not a type check (TypeScript 7 has no JS API here); a file that declares the name anywhere is skipped.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RISKY = ["self", "top", "parent", "opener", "event"];
const ALLOWED: Record<string, string[]> = { "graphworker.ts": ["self"] }; // the worker's own global scope

const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');

function strayGlobals(file: string, code: string): string[] {
  const src = strip(code);
  return RISKY.filter((name) => {
    if (ALLOWED[file]?.includes(name)) return false;
    const declared = new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b|[(,]\\s*${name}\\s*[,)=:]|\\b${name}\\s*=>`).test(src);
    const used = new RegExp(`(?<![.\\w$])${name}(?![\\w$]|\\s*:)`).test(src);
    return used && !declared;
  });
}

describe("DOM globals", () => {
  it("the scan catches a stray global and passes a declared one", () => {
    expect(strayGlobals("x.ts", "if (!self) go();")).toEqual(["self"]);
    expect(strayGlobals("x.ts", "const self = a === b; if (!self) go();")).toEqual([]);
    expect(strayGlobals("x.ts", "el.addEventListener('k', (event) => event.key); o.parent; ({ top: 1 });")).toEqual([]);
  });

  it("no source file reads one by accident", () => {
    const dir = join(__dirname);
    const offenders = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && !f.startsWith("wasm"))
      .flatMap((f) => strayGlobals(f, readFileSync(join(dir, f), "utf8")).map((name) => `${f}: ${name}`));
    expect(offenders).toEqual([]);
  });
});
