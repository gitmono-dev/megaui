import { describe, expect, it, vi } from "vitest";
import type { Database } from "@megaui/database";
import type { AclService } from "../acl";
import { resolveEmbed } from "./embed";
import { resolveBlockReference } from "./block-reference";

vi.mock("./embed", () => ({ resolveEmbed: vi.fn() }));

const acl = {} as AclService;
function database(ids: string[]): Database {
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => ids.map(docId => ({ docId })) }) }) }) } as unknown as Database;
}
function resolved(docId: string, label: string) {
  return { access: "ok", status: "ok", docId, blockId: "block-id____", snapshotBody: JSON.stringify({ root: { children: [{ type: "mega-block", children: [
    { type: "paragraph", children: [{ type: "text", text: label }] },
    { type: "mega-block", children: [{ type: "text", text: "Do not include nested children" }] },
  ] }] } }) } as Awaited<ReturnType<typeof resolveEmbed>>;
}

describe("resolveBlockReference", () => {
  it("uses the copied document identity and returns the complete own-line text", async () => {
    vi.mocked(resolveEmbed).mockResolvedValue(resolved("source", "Long reference ".repeat(20)));
    const result = await resolveBlockReference(database([]), acl, "block-id____", "source", "actor");
    expect(result.label).toBe("Long reference ".repeat(20));
    expect(result.targetDocId).toBe("source");
    expect(resolveEmbed).toHaveBeenLastCalledWith(expect.anything(), acl, "source", "block-id____", "actor");
  });
  it("resolves a plain ID in another readable document", async () => {
    vi.mocked(resolveEmbed).mockImplementation(async (_db, _acl, id) => id === "source" ? resolved(id, "Found") : { status: "unresolved", access: "ok" } as Awaited<ReturnType<typeof resolveEmbed>>);
    expect(await resolveBlockReference(database(["source"]), acl, "block-id____", "current", "actor"))
      .toMatchObject({ targetDocId: "source", label: "Found", status: "ok" });
  });
  it("does not reveal an unreadable source", async () => {
    vi.mocked(resolveEmbed).mockResolvedValue({ status: "unresolved", access: "NO_ACCESS" } as Awaited<ReturnType<typeof resolveEmbed>>);
    expect(await resolveBlockReference(database(["private"]), acl, "block-id____", "current", "actor"))
      .toMatchObject({ label: "((block-id____))", status: "unresolved" });
  });
  it("keeps duplicate readable IDs unresolved without a matching document hint", async () => {
    vi.mocked(resolveEmbed).mockImplementation(async (_db, _acl, id) => resolved(id, id));
    expect(await resolveBlockReference(database(["first", "second"]), acl, "block-id____", "", "actor"))
      .toMatchObject({ label: "((block-id____))", status: "unresolved" });
  });
  it("never redirects a copied document identity to a different source with the same block ID", async () => {
    vi.mocked(resolveEmbed).mockImplementation(async (_db, _acl, id) => id === "other" ? resolved(id, "Wrong source") : { status: "unresolved", access: "NO_ACCESS" } as Awaited<ReturnType<typeof resolveEmbed>>);
    expect(await resolveBlockReference(database(["other"]), acl, "block-id____", "source", "actor", true))
      .toMatchObject({ targetDocId: "source", label: "((block-id____))", status: "unresolved" });
  });
});
