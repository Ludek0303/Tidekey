import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewError, type ViewerContext } from "./index";
import { assetPathOf, createCadViewer, dxfEncoding, layerRows, openDxf } from "./cad";

// dxf-viewer needs WebGL, which jsdom does not have: the viewer is replaced by a recording fake.
const dxf = vi.hoisted(() => {
  const instances: FakeDxfViewer[] = [];
  const gl = { available: true, lost: 0 };
  class FakeDxfViewer {
    readonly options: Record<string, unknown>;
    hasRenderer = gl.available;
    loadError: Error | null = null;
    loads: Record<string, unknown>[] = [];
    shown: [string, boolean][] = [];
    fits: number[][] = [];
    views: [{ x: number; y: number }, number][] = [];
    destroyed = 0;
    layers = [{ name: "0", displayName: "0", color: 0xff0000, visible: true }];
    bounds: { minX: number; maxX: number; minY: number; maxY: number } | null = { minX: 0, maxX: 100, minY: 0, maxY: 50 };
    origin = { x: 10, y: 20 };

    constructor(readonly host: HTMLElement, options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
      this.host.appendChild(document.createElement("canvas"));
    }
    HasRenderer(): boolean {
      return this.hasRenderer;
    }
    async Load(params: Record<string, unknown>): Promise<void> {
      this.loads.push(params);
      if (this.loadError) throw this.loadError;
    }
    GetLayers(): typeof this.layers {
      return this.layers;
    }
    ShowLayer(name: string, show: boolean): void {
      this.shown.push([name, show]);
    }
    GetBounds(): typeof this.bounds {
      return this.bounds;
    }
    GetOrigin(): { x: number; y: number } {
      return this.origin;
    }
    FitView(...args: number[]): void {
      this.fits.push(args);
    }
    GetCamera(): { left: number; right: number; position: { x: number; y: number } } {
      return { left: -50, right: 50, position: { x: 0, y: 0 } };
    }
    GetCanvas(): { width: number } {
      return { width: 1000 };
    }
    SetView(center: { x: number; y: number }, width: number): void {
      this.views.push([center, width]);
    }
    Subscribe(): void {}
    Render(): void {}
    GetRenderer(): { forceContextLoss(): void } {
      return { forceContextLoss: () => gl.lost++ };
    }
    Destroy(): void {
      this.destroyed++;
    }
  }
  return { instances, FakeDxfViewer, gl };
});

vi.mock("dxf-viewer", () => ({ DxfViewer: dxf.FakeDxfViewer }));

const MIB = 1024 * 1024;
const created: string[] = [];
const revoked: string[] = [];

function ctx(overrides: Partial<ViewerContext> = {}): ViewerContext {
  return {
    host: document.createElement("div"),
    name: "rysunek.dxf",
    mime: "image/vnd.dxf",
    size: 10,
    signal: new AbortController().signal,
    theme: {
      name: "dark",
      colors: { bg: "#161719", panel: "#1e1f22", text: "#ececf0", muted: "#a6a6b2", accent: "#b4a0ff", border: "#35363c" },
    },
    asset: vi.fn(async () => new ArrayBuffer(4)),
    spawnWorker: async () => null,
    status: vi.fn(),
    nav: vi.fn(),
    ...overrides,
  };
}

const bytes = (): ArrayBuffer => new TextEncoder().encode("0\nSECTION\n").buffer as ArrayBuffer;

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  dxf.instances.length = 0;
  dxf.gl.lost = 0;
  dxf.gl.available = true;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => {
      const url = `blob:frame/${created.length + 1}`;
      created.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assetPathOf", () => {
  it("zamienia adres zbudowany przez Vite na ścieżkę assetu ramki", () => {
    expect(assetPathOf("/preview/assets/Roboto-Regular-AbC123.woff")).toBe("assets/Roboto-Regular-AbC123.woff");
  });
});

describe("layerRows", () => {
  it("bierze nazwę, kolor i stan z GetLayers()", () => {
    expect(
      layerRows([
        { name: "0", displayName: "0", color: 0x0000ff, visible: true },
        { name: "Ściany", displayName: "Ściany", color: 0, visible: false },
      ]),
    ).toEqual([
      { name: "0", label: "0", color: "#0000ff", visible: true },
      { name: "Ściany", label: "Ściany", color: "#000000", visible: false },
    ]);
  });
});

describe("openDxf", () => {
  it("wczytuje plik i czcionkę z blob: bez workera i pokazuje liczbę warstw", async () => {
    const c = ctx();
    const drawing = await openDxf(bytes(), c);
    expect(drawing).not.toBeNull();
    const [viewer] = dxf.instances;
    expect(viewer.loads).toHaveLength(1);
    const params = viewer.loads[0];
    expect(params.workerFactory).toBeNull();
    expect(String(params.url)).toMatch(/^blob:/);
    expect(params.fonts).toEqual([expect.stringMatching(/^blob:/)]);
    expect(c.asset).toHaveBeenCalledWith(expect.stringMatching(/Roboto-Regular.*\.woff$/));
    expect(c.status).toHaveBeenCalledWith("Warstw: 1");
    expect(viewer.options.blackWhiteInversion).toBe(true);
    expect(viewer.options.autoResize).toBe(true);
  });

  it("dispose zwalnia każdy utworzony URL blob:, niszczy viewer i usuwa swoje elementy", async () => {
    const c = ctx();
    const drawing = await openDxf(bytes(), c);
    expect(created).toHaveLength(2);
    drawing?.dispose();
    expect([...revoked].sort()).toEqual([...created].sort());
    expect(dxf.instances[0].destroyed).toBe(1);
    expect(dxf.gl.lost).toBe(1);
    expect(c.host.children).toHaveLength(0);
  });

  it("bez WebGL kończy się błędem unsupported i zwalnia URL-e", async () => {
    dxf.gl.available = false;
    const c = ctx();
    await expect(openDxf(bytes(), c)).rejects.toMatchObject({ code: "unsupported" });
    expect(revoked).toEqual(created);
    expect(c.host.children).toHaveLength(0);
  });

  it("błąd parsowania daje corrupt i zwalnia URL-e", async () => {
    const c = ctx();
    vi.spyOn(dxf.FakeDxfViewer.prototype, "Load").mockRejectedValueOnce(new Error("Cannot parse group code"));
    const err = await openDxf(bytes(), c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewError);
    expect((err as PreviewError).code).toBe("corrupt");
    expect(revoked).toEqual(created);
  });

  it("plik ponad 50 MiB odrzuca przed jakimkolwiek viewerem", async () => {
    const big = { byteLength: 50 * MIB + 1 } as ArrayBuffer;
    await expect(openDxf(big, ctx())).rejects.toMatchObject({ code: "too-large" });
    expect(dxf.instances).toHaveLength(0);
  });

  it("przerwanie w trakcie pobierania czcionki nie tworzy viewer ani URL-i", async () => {
    const controller = new AbortController();
    const c = ctx({
      signal: controller.signal,
      asset: vi.fn(async () => {
        controller.abort();
        return new ArrayBuffer(4);
      }),
    });
    await expect(openDxf(bytes(), c)).resolves.toBeNull();
    expect(dxf.instances).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("przełącznik warstwy wywołuje ShowLayer", async () => {
    const c = ctx();
    await openDxf(bytes(), c);
    const box = c.host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(true);
    if (!box) throw new Error("brak przełącznika warstwy");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(dxf.instances[0].shown).toEqual([["0", false]]);
  });

  it("przycisk Pokaż/Ukryj składa i rozwija listę warstw", async () => {
    const c = ctx();
    await openDxf(bytes(), c);
    const toggle = c.host.querySelector<HTMLButtonElement>(".r-boczne-przelacz");
    const panel = c.host.querySelector<HTMLElement>(".r-boczne");
    expect(panel?.dataset.zwiniety).toBe("true");
    toggle?.click();
    expect(panel?.dataset.zwiniety).toBe("false");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.textContent).toBe("Ukryj");
  });

  it("Dopasuj dopasowuje do granic rysunku bez punktu początkowego", async () => {
    const c = ctx();
    await openDxf(bytes(), c);
    const bar = c.host.querySelector(".r-narzedzia");
    const fit = [...(bar?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Dopasuj");
    fit?.click();
    expect(dxf.instances[0].fits.at(-1)).toEqual([-10, 90, -20, 30]);
  });

  it("+ przybliża kamerę o krok, zachowując środek widoku", async () => {
    const drawing = await openDxf(bytes(), ctx());
    drawing?.command("zoom-in");
    expect(dxf.instances[0].views.at(-1)).toEqual([expect.objectContaining({ x: 0, y: 0 }), 80]);
  });
});

describe("createCadViewer", () => {
  it("nie rysuje, gdy zamknięto ramkę w trakcie otwierania", async () => {
    const viewer = createCadViewer();
    const c = ctx();
    const opening = viewer.open(bytes(), c);
    viewer.dispose();
    await opening;
    expect(revoked).toEqual(created);
    expect(c.host.children).toHaveLength(0);
  });
});

describe("dxfEncoding", () => {
  const dxf = (header: string): Uint8Array => new TextEncoder().encode(`  0\nSECTION\n  2\nHEADER\n${header}  0\nENDSEC\n`);
  it("reads the code page of an old drawing and trusts UTF-8 from R2007 on", () => {
    expect(dxfEncoding(dxf("  9\n$ACADVER\n  1\nAC1009\n  9\n$DWGCODEPAGE\n  3\nANSI_1250\n"))).toBe("windows-1250");
    expect(dxfEncoding(dxf("  9\r\n$ACADVER\r\n  1\r\nAC1032\r\n  9\r\n$DWGCODEPAGE\r\n  3\r\nANSI_1252\r\n"))).toBe("utf-8");
    expect(dxfEncoding(dxf("  9\n$ACADVER\n  1\nAC1015\n"))).toBe("utf-8");
    expect(dxfEncoding(dxf("  9\n$DWGCODEPAGE\n  3\nANSI_9999\n"))).toBe("utf-8");
    expect(dxfEncoding(new Uint8Array())).toBe("utf-8");
  });
});
