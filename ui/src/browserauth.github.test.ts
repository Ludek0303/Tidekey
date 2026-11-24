import { describe, expect, it } from "vitest";
import { keyFromRecovery, personalArchiveSecret } from "./browserauth";

describe("the archive secret of Moje notatki", () => {
  it("is 32 bytes, the same for the same personal key and different for another", async () => {
    const a = await keyFromRecovery("11".repeat(32));
    const a2 = await keyFromRecovery("11".repeat(32));
    const b = await keyFromRecovery("22".repeat(32));
    const sa = await personalArchiveSecret(a);
    expect(sa).toHaveLength(32);
    expect(await personalArchiveSecret(a2)).toEqual(sa);
    expect(await personalArchiveSecret(b)).not.toEqual(sa);
  });
});
