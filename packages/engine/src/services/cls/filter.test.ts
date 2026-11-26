// EG-05 AC1: CL list filter-string parse/eval — illegal strings are rejected
// as *structured* filters (never thrown as errors) and fall back to plain
// searchable text. `parseQuery` / `matchesCLFilter` are the single source of
// truth (@megaui/core, GC-02); this file exercises them against CL-shaped
// data the way `createClsService.listCLs` consumes them.
import { describe, expect, it } from "vitest";
import { matchesCLFilter, parseQuery, type CL } from "@megaui/core";

function makeCL(overrides: Partial<CL> = {}): CL {
  return {
    id: "cl_1",
    publicId: "Q7rE8kzpY01A",
    number: 10,
    title: "Add streaming diff viewer",
    description: "Adds a streaming renderer for large diffs.",
    state: "ready",
    packageId: "pkg-a",
    author: { id: "usr_alice", username: "alice", displayName: "Alice", avatarInitials: "AL" },
    reviewers: [
      {
        user: { id: "usr_carol", username: "carol", displayName: "Carol", avatarInitials: "CA" },
        verdict: "pending",
      },
    ],
    additions: 12,
    deletions: 3,
    files: [],
    revisions: [],
    ci: "passing",
    merge: "needs-review",
    atomic: false,
    crossPackage: [],
    linkedIssues: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseQuery — illegal CL filter tokens are rejected as structured filters, never thrown", () => {
  it("keeps an unknown is: state as plain searchable text", () => {
    expect(parseQuery("is:archived")).toEqual({ text: "is:archived" });
    expect(() => parseQuery("is:archived")).not.toThrow();
  });

  it("keeps pkg:* combined with other values as plain text (pkg:* must stand alone)", () => {
    expect(parseQuery("pkg:*,pkg-a")).toEqual({ text: "pkg:*,pkg-a" });
  });

  it("keeps a malformed actor token (spaces, no leading identifier char) as plain text", () => {
    expect(parseQuery("reviewer: ")).toEqual({ text: "reviewer:" });
    expect(parseQuery("reviewer:!!!")).toEqual({ text: "reviewer:!!!" });
  });

  it("keeps an unknown sort value as plain text instead of applying it", () => {
    expect(parseQuery("sort:bogus-order")).toEqual({ text: "sort:bogus-order" });
  });

  it("never throws for adversarial/garbage input, and still extracts the legal terms it can", () => {
    const adversarial = "is:merged,;;garbage priority:zz..yy pkg: label: sort:hack @@@ is:ready";
    expect(() => parseQuery(adversarial)).not.toThrow();
    const parsed = parseQuery(adversarial);
    // `is:ready` is the only fully-legal structured term in this string; every
    // illegal token (including the empty-value `pkg:`/`label:` and the
    // bogus sort) is preserved verbatim as searchable text, nothing is lost
    // or silently dropped.
    expect(parsed.states).toEqual(["ready"]);
    expect(parsed.text).toContain("is:merged,;;garbage");
    expect(parsed.text).toContain("pkg:");
    expect(parsed.text).toContain("label:");
    expect(parsed.text).toContain("sort:hack");
  });

  it("round-trips a fully legal CL query", () => {
    expect(parseQuery("is:ready,wip pkg:pkg-a reviewer:@me sort:updated-asc")).toEqual({
      states: ["ready", "wip"],
      packageIds: ["pkg-a"],
      reviewer: "@me",
      sort: "updated-asc",
    });
  });
});

describe("matchesCLFilter — evaluates a parsed query against CL rows", () => {
  it("matches everything for an empty filter", () => {
    expect(matchesCLFilter(makeCL(), parseQuery(""), "usr_alice")).toBe(true);
  });

  it("evaluates a state + package + reviewer(@me) query end-to-end", () => {
    const cl = makeCL();
    expect(matchesCLFilter(cl, parseQuery("is:ready pkg:pkg-a reviewer:@me"), "usr_carol")).toBe(true);
    expect(matchesCLFilter(cl, parseQuery("is:ready pkg:pkg-a reviewer:@me"), "usr_alice")).toBe(false);
    expect(matchesCLFilter(cl, parseQuery("is:wip"), "usr_carol")).toBe(false);
    expect(matchesCLFilter(cl, parseQuery("pkg:pkg-b"), "usr_carol")).toBe(false);
  });

  it("an illegal is: token falls back to text search, so it filters by substring instead of state", () => {
    const cl = makeCL({ title: "is:archived legacy cleanup" });
    // The whole illegal token round-trips as free text, matched case-insensitively
    // against title+description — it never throws and never matches by state.
    expect(matchesCLFilter(cl, parseQuery("is:archived"), "usr_alice")).toBe(true);
    expect(matchesCLFilter(makeCL(), parseQuery("is:archived"), "usr_alice")).toBe(false);
  });

  it("matches cross-package ids via crossPackage", () => {
    const cl = makeCL({ crossPackage: ["pkg-b"] });
    expect(matchesCLFilter(cl, parseQuery("pkg:pkg-b"), "usr_alice")).toBe(true);
    expect(matchesCLFilter(cl, parseQuery("pkg:pkg-c"), "usr_alice")).toBe(false);
  });

  it("resolves author @me against the current actor id", () => {
    const cl = makeCL();
    expect(matchesCLFilter(cl, parseQuery("author:@me"), "usr_alice")).toBe(true);
    expect(matchesCLFilter(cl, parseQuery("author:@me"), "usr_carol")).toBe(false);
  });
});
