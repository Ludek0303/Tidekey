// utif 3.1.0 ships no typings. These are the parts the TIFF viewer (viewers/tiff.ts) uses.
declare module "utif" {
  /** An image file directory: the header tags (t256 width, t257 height, ...) and, after decodeImage, the pixels. */
  export interface Ifd {
    t256?: number[];
    t257?: number[];
    t258?: number[];
    t277?: number[];
    t322?: number[];
    t323?: number[];
    data?: Uint8Array;
  }

  interface Utif {
    decode(buffer: ArrayBuffer): Ifd[];
    decodeImage(buffer: ArrayBuffer, ifd: Ifd): void;
    toRGBA8(ifd: Ifd): Uint8Array;
  }

  const UTIF: Utif;
  export default UTIF;
}
