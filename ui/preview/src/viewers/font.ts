// Fonts: the name and glyph count from the file (opentype.js, for the header), and a sample drawn with the browser's
// own FontFace built from the same bytes (PODGLAD-PLAN §5).
import { parse } from "opentype.js";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

export interface FontFacts { family: string | null; style: string | null; glyphs: number | null; version: string | null }

export const SAMPLE = "Zażółć gęślą jaźń";
const SIZES = [12, 18, 24, 36, 48, 72];
const ALPHABET = "AĄBCĆDEĘFGHIJKLŁMNŃOÓPRSŚTUWYZŹŻ aąbcćdeęfghijklłmnńoóprsśtuwyzźż 0123456789 .,:;!?()";
const NONE: FontFacts = { family: null, style: null, glyphs: null, version: null };

/** opentype.parse in try/catch; WOFF2 (opentype.js does not read it) gives all nulls, with no error. */
export function fontFacts(bytes: ArrayBuffer): FontFacts {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (String.fromCharCode(...head) === "wOF2") return NONE;
  try {
    const font = parse(bytes);
    const version = font.getEnglishName("version");
    return {
      family: font.getEnglishName("fontFamily") || null,
      style: font.getEnglishName("fontSubfamily") || null,
      glyphs: font.numGlyphs ?? null,
      version: version ? version.replace(/^version\s*/i, "") : null,
    };
  } catch {
    return NONE;
  }
}

export function createFontViewer(): Viewer {
  let face: FontFace | null = null;
  let root: HTMLElement | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const facts = fontFacts(bytes);
      // a random family name: the file's own name is never put into CSS
      const family = `podglad-${Math.random().toString(36).slice(2, 10)}`;
      const loaded = new FontFace(family, bytes);
      try {
        await loaded.load();
      } catch {
        throw new PreviewError("corrupt");
      }
      if (ctx.signal.aborted) return;
      document.fonts.add(loaded);
      face = loaded;

      const view = document.createElement("div");
      view.className = "r-font";
      const title = document.createElement("h1");
      title.textContent = facts.family ?? ctx.name;
      const info = document.createElement("p");
      info.className = "r-font-opis";
      const parts = [
        "Font",
        facts.style,
        facts.glyphs === null ? null : `${facts.glyphs} glifów`,
        facts.version ? `wersja ${facts.version}` : null,
      ];
      info.textContent = parts.filter((s): s is string => s !== null).join(" · ");
      view.append(title, info);

      for (const size of SIZES) {
        const row = document.createElement("div");
        row.className = "r-font-wiersz";
        const label = document.createElement("span");
        label.className = "r-font-rozmiar";
        label.textContent = `${size} px`;
        const sample = document.createElement("p");
        sample.className = "r-font-probka";
        sample.style.fontFamily = `"${family}"`;
        sample.style.fontSize = `${size}px`;
        sample.textContent = SAMPLE;
        row.append(label, sample);
        view.append(row);
      }
      const alphabet = document.createElement("p");
      alphabet.className = "r-font-abeceda";
      alphabet.style.fontFamily = `"${family}"`;
      alphabet.textContent = ALPHABET;
      view.append(alphabet);

      ctx.host.append(view);
      root = view;
    },

    dispose(): void {
      root?.remove();
      root = null;
      if (face) document.fonts.delete(face);
      face = null;
    },
  };
}
