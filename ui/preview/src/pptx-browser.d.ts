// pptx-browser 4.1.5 ships no type declarations: this is the part of its API that viewers/pptx.ts uses.
declare module "pptx-browser" {
  export class PptxRenderer {
    slideCount: number;
    load(source: ArrayBuffer): Promise<void>;
    renderSlide(slideIndex: number, canvas: HTMLCanvasElement, width?: number): Promise<void>;
    destroy(): void;
  }
}
