// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { spawnWorker } from "./worker";

describe("spawnWorker", () => {
  it("w środowisku bez Worker zwraca null bez wyjątku", async () => {
    expect(typeof Worker).toBe("undefined");
    await expect(spawnWorker("self.onmessage = null;")).resolves.toBeNull();
  });
});
