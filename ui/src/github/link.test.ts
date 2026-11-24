import { describe, expect, it } from "vitest";
import {
  linkFolder,
  linkOfNote,
  linksOfProject,
  mergeLinks,
  newLink,
  validLink,
  type GithubLink,
} from "./link";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

// A valid record; tests change one field at a time.
function link(over: Partial<GithubLink> = {}): GithubLink {
  return {
    id: ID_A,
    projectPath: "Projekty/Alfa",
    repo: "owner/repo",
    ref: null,
    repoPath: "",
    target: "GitHub",
    include: ["**/*.md"],
    onDelete: "keep",
    allowEdits: true,
    lastCommit: SHA_A,
    lastAppliedAt: 1000,
    lastAppliedBy: "Jan",
    files: {},
    ignored: [],
    status: "ok",
    rev: 1,
    ...over,
  };
}

describe("newLink", () => {
  it("makes a valid record with a 32 hex id and the defaults", () => {
    const l = newLink("Projekty/Alfa", "owner/repo", {});
    expect(l.id).toMatch(/^[0-9a-f]{32}$/);
    expect(l.ref).toBeNull();
    expect(l.repoPath).toBe("");
    expect(l.target).toBe("GitHub");
    expect(l.include).toEqual(["**/*.md", "**/*.markdown", "**/README"]);
    expect(l.onDelete).toBe("keep");
    expect(l.allowEdits).toBe(true);
    expect(l.lastCommit).toBeNull();
    expect(l.files).toEqual({});
    expect(l.ignored).toEqual([]);
    expect(l.rev).toBe(1);
    expect(validLink(l)).toBe(true);
  });

  it("takes the options it is given", () => {
    const l = newLink("P", "o/r", { ref: "main", repoPath: "docs", target: "GitHub/r", onDelete: "trash", allowEdits: false });
    expect(l).toMatchObject({ ref: "main", repoPath: "docs", target: "GitHub/r", onDelete: "trash", allowEdits: false });
  });

  it("gives every link a different id", () => {
    expect(newLink("P", "o/r", {}).id).not.toBe(newLink("P", "o/r", {}).id);
  });
});

describe("validLink", () => {
  it("accepts a complete record", () => {
    const withFile = link({
      files: { "note-1": { path: "docs/a.md", blobSha: SHA_B, guarded: ["0a1b2c3d"], conflict: { blobSha: SHA_B, commit: SHA_A } } },
      ignored: ["docs/old.md"],
      etag: '"abc"',
      lastCommit: null,
      lastAppliedAt: null,
      lastAppliedBy: null,
    });
    expect(validLink(withFile)).toBe(true);
  });

  it("rejects things that are not records", () => {
    expect(validLink(null)).toBe(false);
    expect(validLink("x")).toBe(false);
    expect(validLink([])).toBe(false);
  });

  it("rejects a bad id", () => {
    expect(validLink(link({ id: "ABC" }))).toBe(false);
    expect(validLink(link({ id: "g".repeat(32) }))).toBe(false);
    expect(validLink(link({ id: "a".repeat(31) }))).toBe(false);
  });

  it("rejects a repo that is not owner/name, or has ..", () => {
    expect(validLink(link({ repo: "owner" }))).toBe(false);
    expect(validLink(link({ repo: "a/b/c" }))).toBe(false);
    expect(validLink(link({ repo: "../x" }))).toBe(false);
    expect(validLink(link({ repo: "owner/.." }))).toBe(false);
    expect(validLink(link({ repo: "a b/c" }))).toBe(false);
  });

  it("rejects an empty project path", () => {
    expect(validLink(link({ projectPath: "" }))).toBe(false);
  });

  it("rejects bad targets", () => {
    for (const target of ["../x", "GitHub/../x", "C:", "C:/x", "/abs", "a\\b", "GitHub/"]) {
      expect(validLink(link({ target })), target).toBe(false);
    }
    expect(validLink(link({ target: "GitHub/repo.name" }))).toBe(true);
    // "" = the files go straight into the project folder, beside the user's own notes
    expect(validLink(link({ target: "" }))).toBe(true);
  });

  it("rejects a bad commit sha, and accepts null", () => {
    expect(validLink(link({ lastCommit: "a".repeat(39) }))).toBe(false);
    expect(validLink(link({ lastCommit: "A".repeat(40) }))).toBe(false);
    expect(validLink(link({ lastCommit: null }))).toBe(true);
  });

  it("rejects a bad rev, onDelete or flags", () => {
    expect(validLink(link({ rev: 0 }))).toBe(false);
    expect(validLink(link({ rev: 1.5 }))).toBe(false);
    expect(validLink(link({ onDelete: "delete" as "keep" }))).toBe(false);
    expect(validLink(link({ allowEdits: "yes" as unknown as boolean }))).toBe(false);
  });

  it("rejects a file with a bad path or blob sha", () => {
    expect(validLink(link({ files: { n: { path: "../a.md", blobSha: SHA_B, guarded: [] } } }))).toBe(false);
    expect(validLink(link({ files: { n: { path: "a.md", blobSha: "b".repeat(39), guarded: [] } } }))).toBe(false);
    expect(validLink(link({ files: { n: { path: "a.md", blobSha: SHA_B, guarded: ["xyz"] } } }))).toBe(false);
  });

  it("rejects an ignored path that escapes the folder", () => {
    expect(validLink(link({ ignored: ["/etc/x.md"] }))).toBe(false);
  });
});

describe("mergeLinks", () => {
  it("keeps the record with the higher rev", () => {
    const local = [link({ rev: 2, status: "local" })];
    const remote = [link({ rev: 3, status: "remote" })];
    expect(mergeLinks(local, remote)[0].status).toBe("remote");
    expect(mergeLinks(remote, local)[0].status).toBe("remote");
  });

  it("on equal rev, takes the later lastAppliedAt", () => {
    const local = [link({ rev: 2, lastAppliedAt: 5, status: "local" })];
    const remote = [link({ rev: 2, lastAppliedAt: 9, status: "remote" })];
    expect(mergeLinks(local, remote)[0].status).toBe("remote");
    expect(mergeLinks(remote, local)[0].status).toBe("remote");
  });

  it("on a full tie, keeps the local record", () => {
    const local = [link({ rev: 2, lastAppliedAt: 5, status: "local" })];
    const remote = [link({ rev: 2, lastAppliedAt: 5, status: "remote" })];
    expect(mergeLinks(local, remote)[0].status).toBe("local");
  });

  it("drops invalid remote records and keeps the valid ones", () => {
    const remote = [link({ id: ID_B }), { junk: true } as unknown as GithubLink, link({ id: "bad", rev: 9 })];
    const merged = mergeLinks([], remote);
    expect(merged.map((l) => l.id)).toEqual([ID_B]);
  });

  it("adds records that exist on one side only, sorted by id", () => {
    const merged = mergeLinks([link({ id: ID_B })], [link({ id: ID_A })]);
    expect(merged.map((l) => l.id)).toEqual([ID_A, ID_B]);
  });
});

describe("link lookups", () => {
  const files = { "note-1": { path: "docs/a.md", blobSha: SHA_B, guarded: [] } };
  const a = link({ id: ID_A, projectPath: "Projekty/Alfa", files });
  const b = link({ id: ID_B, projectPath: "Projekty/Beta", target: "GitHub/repo" });

  it("linkFolder joins the project and the target", () => {
    expect(linkFolder(a)).toBe("Projekty/Alfa/GitHub");
    expect(linkFolder(b)).toBe("Projekty/Beta/GitHub/repo");
  });

  it("linkFolder is the project folder itself when the target is empty", () => {
    expect(linkFolder(link({ projectPath: "Projekty/Gamma", target: "" }))).toBe("Projekty/Gamma");
  });

  it("linksOfProject finds the links of one project", () => {
    expect(linksOfProject([a, b], "Projekty/Beta")).toEqual([b]);
    expect(linksOfProject([a, b], "Projekty/Gamma")).toEqual([]);
  });

  it("linkOfNote finds the link and file of a note", () => {
    expect(linkOfNote([a, b], "note-1")).toEqual({ link: a, file: files["note-1"] });
    expect(linkOfNote([a, b], "note-2")).toBeNull();
  });
});
