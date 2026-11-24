import { describe, expect, it } from "vitest";
import { MockRecords } from "./mockrecords";

const settings = (over: Record<string, unknown>) => ({ id: "org-settings", kind: "settings", task_retention_months: 0, ...over });

describe("organization settings in the mock", () => {
  it("accept an activity visibility of admins or members only", () => {
    expect(() => new MockRecords().save(settings({ activity_visibility: "members" }), "none", "me")).not.toThrow();
    expect(() => new MockRecords().save(settings({ activity_visibility: "everyone" }), "none", "me")).toThrow("Nieprawidłowe ustawienia organizacji.");
  });
});
