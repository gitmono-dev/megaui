import type { User } from "@megaui/core";
import { describe, expect, it } from "vitest";

import { isCLViewer, presentCLAuthor } from "@/app/[lang]/workspace/cls/[n]/cl-author";

const viewer = {
  id: "user-17",
  name: "fs_user-17",
  displayName: "沈宁",
  image: "/profile/17.png",
};

const author: User = {
  id: "mega2:fs_user-17",
  username: "fs_user-17",
  displayName: "fs_user-17",
  avatarInitials: "FS",
  avatarColor: "#72809a",
};

describe("CL author presentation", () => {
  it("uses the current Feishu user's name and avatar for an exact Mega2 identity", () => {
    expect(isCLViewer(author, viewer)).toBe(true);
    expect(presentCLAuthor(author, viewer)).toEqual({
      ...author,
      displayName: "沈宁",
      avatarInitials: "沈宁",
      avatarUrl: "/profile/17.png",
    });
  });

  it("uses the local account id and keeps the existing image when the session has none", () => {
    const local = { ...author, id: viewer.id, username: "grace", avatarUrl: "/existing.png" };
    const legacyViewer = { id: viewer.id, name: "Grace Hopper" };
    expect(isCLViewer(local, legacyViewer)).toBe(true);
    expect(presentCLAuthor(local, legacyViewer)).toEqual({
      ...local,
      displayName: "Grace Hopper",
      avatarInitials: "GH",
    });
  });

  it.each([
    { ...author, id: "other-user", displayName: viewer.displayName },
    { ...author, id: "mega2:other-user" },
    { ...author, username: "other-user" },
  ])("preserves a different author's identity and presentation", (other) => {
    expect(isCLViewer(other, viewer)).toBe(false);
    expect(presentCLAuthor(other, viewer)).toEqual(other);
  });

  it.each([null, undefined])("preserves the original author without a session", (sessionUser) => {
    expect(isCLViewer(author, sessionUser)).toBe(false);
    expect(presentCLAuthor(author, sessionUser)).toEqual(author);
  });
});
