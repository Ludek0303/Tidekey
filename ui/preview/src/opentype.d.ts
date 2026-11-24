// opentype.js 2.0.0 ships no type declarations: this is the part of its API that viewers/font.ts uses.
declare module "opentype.js" {
  export interface OpenTypeFont {
    numGlyphs: number;
    getEnglishName(name: string): string | undefined;
  }
  export function parse(buffer: ArrayBuffer): OpenTypeFont;
}
