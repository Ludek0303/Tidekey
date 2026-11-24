// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameImage } from "./frame";

// A fake frame: each frame() call waits until the test resolves or rejects it.
interface Call { bytes: ArrayBuffer; resolve(image: FrameImage): void; reject(error: unknown): void }
interface FakeHost { calls: Call[]; destroy: ReturnType<typeof vi.fn>; element: HTMLIFrameElement }
const made = vi.hoisted(() => [] as FakeHost[]);

vi.mock("./frame", async (importOriginal) => {
  const real = await importOriginal<typeof import("./frame")>();
  class FakeFrameHost {
    calls: Call[] = [];
    element = document.createElement("iframe");
    destroy = vi.fn();
    constructor() { made.push(this); }
    frame(file: { bytes: ArrayBuffer }): Promise<FrameImage> {
      return new Promise<FrameImage>((resolve, reject) => this.calls.push({ bytes: file.bytes, resolve, reject }));
    }
  }
  return { ...real, FrameHost: FakeFrameHost };
});

const IMAGE: FrameImage = { width: 2, height: 1, pixels: new ArrayBuffer(8) };
const MIB = 1024 * 1024;

type FramejobModule = typeof import("./framejob");
let firstFrameOf: FramejobModule["firstFrameOf"];
let VIDEO_THUMB_HEAD: number;

// Lets promise callbacks run (fake timers do not move them).
const settle = async () => { await vi.advanceTimersByTimeAsync(0); for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.useFakeTimers();
  made.length = 0;
  vi.resetModules();
  const mod = await import("./framejob");
  firstFrameOf = mod.firstFrameOf;
  VIDEO_THUMB_HEAD = mod.VIDEO_THUMB_HEAD;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("firstFrameOf", () => {
  it("runs the jobs one after another on one frame", async () => {
    const first = firstFrameOf(new Blob(["a"]), "a.mp4", "video/mp4");
    const second = firstFrameOf(new Blob(["b"]), "b.mp4", "video/mp4");
    await settle();
    expect(made).toHaveLength(1);
    expect(made[0].calls).toHaveLength(1);
    made[0].calls[0].resolve(IMAGE);
    await expect(first).resolves.toEqual(IMAGE);
    await settle();
    expect(made[0].calls).toHaveLength(2);
    made[0].calls[1].resolve({ ...IMAGE, durationMs: 4000 });
    await expect(second).resolves.toMatchObject({ durationMs: 4000 });
  });

  it("sends only the first 16 MiB of a big file", async () => {
    const job = firstFrameOf(new Blob([new Uint8Array(40 * MIB)]), "duzy.mp4", "video/mp4");
    await settle();
    expect(VIDEO_THUMB_HEAD).toBe(16 * MIB);
    expect(made[0].calls[0].bytes.byteLength).toBe(16 * MIB);
    made[0].calls[0].resolve(IMAGE);
    await job;
  });

  it("a job over 20 s fails with timeout, drops the frame, and the next job gets a new one", async () => {
    const slow = firstFrameOf(new Blob(["x"]), "wolny.mp4", "video/mp4");
    const next = firstFrameOf(new Blob(["y"]), "nastepny.mp4", "video/mp4");
    await settle();
    const expired = expect(slow).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(20_000);
    await expired;
    expect(made[0].destroy).toHaveBeenCalledTimes(1);
    await settle();
    expect(made).toHaveLength(2);
    made[1].calls[0].resolve(IMAGE);
    await expect(next).resolves.toEqual(IMAGE);
  });

  it("removes the frame after 30 s without work", async () => {
    const job = firstFrameOf(new Blob(["x"]), "a.mp4", "video/mp4");
    await settle();
    made[0].calls[0].resolve(IMAGE);
    await job;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(made[0].destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(made[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("removes the frame when the page is hidden for good", async () => {
    const job = firstFrameOf(new Blob(["x"]), "a.mp4", "video/mp4");
    await settle();
    made[0].calls[0].resolve(IMAGE);
    await job;
    window.dispatchEvent(new Event("pagehide"));
    expect(made[0].destroy).toHaveBeenCalledTimes(1);
  });
});
