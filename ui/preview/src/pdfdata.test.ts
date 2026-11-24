import { describe, expect, it } from "vitest";
import { assetPathFor } from "./pdfdata";

describe("assetPathFor", () => {
  it("zamienia adres danych pdf.js na nazwę zasobu aplikacji", () => {
    expect(assetPathFor("pdfjs-cmaps/UniGB-UCS2-H.bcmap")).toBe("assets/pdfjs-cmaps-UniGB-UCS2-H.bcmap");
    expect(assetPathFor("pdfjs-fonts/LiberationSans-Regular.ttf")).toBe("assets/pdfjs-fonts-LiberationSans-Regular.ttf");
    expect(assetPathFor("pdfjs-wasm/openjpeg.wasm")).toBe("assets/pdfjs-wasm-openjpeg.wasm");
    expect(assetPathFor("pdfjs-icc/CGATS001Compat-v2-micro.icc")).toBe("assets/pdfjs-icc-CGATS001Compat-v2-micro.icc");
  });

  it("cokolwiek innego: null", () => {
    expect(assetPathFor("../x")).toBeNull();
    expect(assetPathFor("https://example.com/a.bcmap")).toBeNull();
    expect(assetPathFor("pdfjs-cmaps/../../a")).toBeNull();
    expect(assetPathFor("pdfjs-cmaps/.hidden")).toBeNull();
    expect(assetPathFor("pdfjs-cmaps/")).toBeNull();
    expect(assetPathFor("pdfjs-other/x.bcmap")).toBeNull();
    expect(assetPathFor("assets/pdfjs-cmaps-x.bcmap")).toBeNull();
  });
});
