import { describe, expect, it } from "vitest";

import type { Doc, User } from "@megaui/core";

import {
  catalogsFromDocs,
  filterDocs,
  previewLines,
  sortDocs,
  UNSORTED_FOLDER_ID,
} from "./docs-filter";

const AUTHOR: User = {
  id: "u1",
  username: "ada",
  displayName: "Ada",
  avatarInitials: "A",
};

function doc(overrides: Partial<Doc> & Pick<Doc, "id" | "title">): Doc {
  return {
    body: "{}",
    excerpt: "",
    author: AUTHOR,
    collaborators: [AUTHOR],
    tags: [],
    linkedCLs: [],
    linkedIssues: [],
    versions: [],
    starred: false,
    preview: [],
    viewCount: 0,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("docs-filter", () => {
  const rust = doc({
    id: "d1",
    title: "Pack decode",
    excerpt: "zstd dictionary",
    folderId: "rust",
    tags: [{ id: "tech", name: "技术", color: "#7c3aed" }],
    updatedAt: "2026-01-03T00:00:00.000Z",
  });
  const loose = doc({
    id: "d2",
    title: "Welcome notes",
    excerpt: "hello",
    starred: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("derives Unsorted plus live folders and tags", () => {
    const catalogs = catalogsFromDocs([rust, loose], "Unsorted");
    expect(catalogs.folders.map((folder) => folder.id)).toEqual([UNSORTED_FOLDER_ID, "rust"]);
    expect(catalogs.tags.map((tag) => tag.id)).toEqual(["tech"]);
  });

  it("filters by starred, folder, tag, and search haystack", () => {
    expect(filterDocs([rust, loose], { kind: "starred" }, "").map((item) => item.id)).toEqual(["d2"]);
    expect(filterDocs([rust, loose], { kind: "folder", folderId: "rust" }, "").map((item) => item.id)).toEqual(["d1"]);
    expect(filterDocs([rust, loose], { kind: "folder", folderId: UNSORTED_FOLDER_ID }, "").map((item) => item.id)).toEqual(
      ["d2"],
    );
    expect(filterDocs([rust, loose], { kind: "tag", tagId: "tech" }, "").map((item) => item.id)).toEqual(["d1"]);
    expect(filterDocs([rust, loose], { kind: "all" }, "zstd").map((item) => item.id)).toEqual(["d1"]);
    expect(filterDocs([rust, loose], { kind: "all" }, "ada").map((item) => item.id)).toEqual(["d1", "d2"]);
  });

  it("sorts by updated desc or title", () => {
    expect(sortDocs([rust, loose], "updated").map((item) => item.id)).toEqual(["d1", "d2"]);
    expect(sortDocs([rust, loose], "title").map((item) => item.id)).toEqual(["d1", "d2"]);
  });

  it("uses excerpt lines when preview is empty", () => {
    expect(previewLines(loose)).toEqual(["hello"]);
    expect(previewLines(doc({ id: "d3", title: "X", preview: ["kept"] }))).toEqual(["kept"]);
  });
});
