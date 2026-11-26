import type { CLFile } from "@megaui/core";
import { describe, expect, it } from "vitest";

import { buildChangedFilesTree } from "@/app/[lang]/workspace/cls/[n]/files/changed-files-tree";

function file(path: string, status: CLFile["status"] = "modified"): CLFile {
  return { path, status, additions: 0, deletions: 0, patch: "", viewed: false, commentCount: 0 };
}

describe("changed files tree", () => {
  it("shares ancestor folders, sorts directories first, and indexes same-named files by full path", () => {
    const first = file("src/lib.rs");
    const nested = file("src/model/lib.rs");
    const { nodes, filesByPath } = buildChangedFilesTree([file("README.md"), first, nested, file("src/api.rs")]);

    expect(nodes).toMatchObject([
      { name: "src", kind: "directory", children: [
        { name: "model", children: [{ name: "lib.rs", path: "src/model/lib.rs" }] },
        { name: "api.rs", kind: "file" },
        { name: "lib.rs", path: "src/lib.rs" },
      ] },
      { name: "README.md", kind: "file" },
    ]);
    expect(filesByPath.get(first.path)).toBe(first);
    expect(filesByPath.get(nested.path)).toBe(nested);
  });

  it("keeps a deleted file and its replacement directory as distinct nodes", () => {
    const oldFile = file("config", "deleted");
    const newFile = file("config/settings.toml", "added");
    const { nodes, filesByPath } = buildChangedFilesTree([oldFile, newFile]);

    expect(nodes).toMatchObject([
      { kind: "directory", path: "config", children: [{ kind: "file", path: "config/settings.toml" }] },
      { kind: "file", path: "config" },
    ]);
    expect(filesByPath.get("config")).toBe(oldFile);
    expect(filesByPath.get("config/settings.toml")).toBe(newFile);
  });
});
