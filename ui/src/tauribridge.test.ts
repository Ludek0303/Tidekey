// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...a) }));

const { TauriBridge, fromWire, reportSmoke, tauriFirstRun, toWire } = await import("./tauribridge");

describe("byte conversion at the IPC edge", () => {
  it("sends Uint8Array as number arrays, also nested in arguments", () => {
    expect(toWire({ id: "n1", update: new Uint8Array([1, 255]) })).toEqual({ id: "n1", update: [1, 255] });
    expect(toWire([new Uint8Array([7])])).toEqual([[7]]);
  });

  it("turns the bytes of open_note back into a Uint8Array and leaves other results alone", () => {
    expect(fromWire("open_note", [0, 9])).toEqual(new Uint8Array([0, 9]));
    expect(fromWire("note_text", "tekst")).toBe("tekst");
  });

  it("reads a raw attachment result, an ArrayBuffer, as bytes", () => {
    expect(fromWire("read_attachment", new Uint8Array([5, 6]).buffer)).toEqual(new Uint8Array([5, 6]));
  });
});

describe("TauriBridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it("calls the command with converted arguments and converts the result", async () => {
    invoke.mockResolvedValueOnce([3, 4]);
    const bridge = new TauriBridge();
    const state = await bridge.call<Uint8Array>("open_note", { id: "n1" });
    expect(invoke).toHaveBeenCalledWith("open_note", { id: "n1" });
    expect(state).toEqual(new Uint8Array([3, 4]));

    await bridge.call("apply_update", { id: "n1", update: new Uint8Array([1]) });
    expect(invoke).toHaveBeenLastCalledWith("apply_update", { id: "n1", update: [1] });
  });

  it("sends an attachment as the raw body, its name percent-encoded in a header", async () => {
    invoke.mockResolvedValueOnce("assets/zdjęcie.png");
    const rel = await new TauriBridge().call<string>("save_attachment", { name: "zdjęcie.png", bytes: new Uint8Array([1, 2]) });
    expect(invoke).toHaveBeenCalledWith("save_attachment", new Uint8Array([1, 2]), {
      headers: { "x-file-name": "zdj%C4%99cie.png" },
    });
    expect(rel).toBe("assets/zdjęcie.png");
  });

  it("rejects with an Error that keeps the backend's message and kind", async () => {
    invoke.mockRejectedValueOnce({ kind: "path_taken", message: "Ścieżka jest zajęta: a.md" });
    const err = await new TauriBridge().call("rename", { id: "n1", path: "a.md" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Ścieżka jest zajęta: a.md");
    expect((err as Error & { kind: string }).kind).toBe("path_taken");
  });

  it("subscribes to backend events and unsubscribes once", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    const cb = vi.fn();
    const off = new TauriBridge().on("tree_changed", cb);
    await Promise.resolve();
    const handler = listen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    handler({ payload: null });
    expect(cb).toHaveBeenCalledWith(null);
    off();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("tauriFirstRun", () => {
  it("asks the backend for the folder, so that only the folder the dialog returned is used", async () => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce("/home/uzytkownik/Notatki");
    const bridge = new TauriBridge();
    await expect(tauriFirstRun(bridge).pickFolder()).resolves.toBe("/home/uzytkownik/Notatki");
    expect(invoke).toHaveBeenCalledWith("pick_folder", {});
  });
});

describe("the window smoke check", () => {
  beforeEach(() => invoke.mockReset());

  it("reports whether the WASM loaded only when the app runs the check", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "smoke_mode" ? true : undefined));
    await reportSmoke(false);
    expect(invoke).toHaveBeenCalledWith("smoke_report", { ok: false, detail: "wasm did not load" });
  });

  it("does nothing in a normal run", async () => {
    invoke.mockImplementation(async () => false);
    await reportSmoke(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("smoke_mode");
  });
});
