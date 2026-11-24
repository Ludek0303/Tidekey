import { afterEach, describe, expect, it, vi } from "vitest";
import { startCapture } from "./capture";

const setMedia = (getUserMedia: () => Promise<unknown>) =>
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });

const deny = (name: string) => () => Promise.reject(new DOMException("test", name));

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

describe("startCapture", () => {
  it("is unsupported without getUserMedia", async () => {
    vi.stubGlobal("AudioWorkletNode", class {});
    await expect(startCapture(() => {})).rejects.toMatchObject({ code: "unsupported" });
  });

  it("is unsupported without AudioWorkletNode", async () => {
    setMedia(deny("NotAllowedError"));
    vi.stubGlobal("AudioWorkletNode", undefined);
    await expect(startCapture(() => {})).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reports a refused microphone as mic-denied", async () => {
    setMedia(deny("NotAllowedError"));
    vi.stubGlobal("AudioWorkletNode", class {});
    await expect(startCapture(() => {})).rejects.toMatchObject({ code: "mic-denied" });
  });

  it("reports a missing microphone as no-mic", async () => {
    setMedia(deny("NotFoundError"));
    vi.stubGlobal("AudioWorkletNode", class {});
    await expect(startCapture(() => {})).rejects.toMatchObject({ code: "no-mic" });
  });
});
