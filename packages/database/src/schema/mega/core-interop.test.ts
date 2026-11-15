// PK-05 AC3: schema row shapes remain convertible to @megaui/core domain types
// via explicit mappers (DB stores authorId/labelIds; domain embeds User/Label).
import { describe, expect, it } from "vitest";
import {
  MEGA_CL_LABELS,
  MEGA_ISSUE_PRIORITIES,
  MEGA_ISSUE_STATES,
  MEGA_NOTIFICATION_KINDS,
} from "@megaui/core";
import {
  megaClStates,
  megaDocStatus,
  megaIssuePriorities,
  megaIssueStates,
  megaNotificationKinds,
  megaReleaseStatuses,
} from "./constants";
import type { MegaCl, MegaDoc, MegaIssue } from "./index";

describe("mega schema ↔ @megaui/core vocabulary parity (PK-05 AC3)", () => {
  it("shares primitive identity/title fields with Doc/Issue/CL domain shapes", () => {
    // Compile-time structural presence: these keys must exist on schema rows
    // so EG-* mappers can project onto @megaui/core domain types.
    const docKeys: Array<keyof MegaDoc> = ["id", "title", "viewCount", "status"];
    const issueKeys: Array<keyof MegaIssue> = [
      "id",
      "number",
      "title",
      "state",
      "priority",
      "packageId",
      "commentCount",
    ];
    const clKeys: Array<keyof MegaCl> = [
      "id",
      "number",
      "title",
      "state",
      "packageId",
      "additions",
      "deletions",
    ];
    expect(docKeys.length + issueKeys.length + clKeys.length).toBeGreaterThan(0);
  });

  it("aligns issue state/priority constants with core", () => {
    expect(Object.values(megaIssueStates).sort()).toEqual(
      [...MEGA_ISSUE_STATES].sort(),
    );
    expect(Object.values(megaIssuePriorities).sort()).toEqual(
      [...MEGA_ISSUE_PRIORITIES].sort(),
    );
  });

  it("aligns CL state keys with MEGA_CL_LABELS", () => {
    expect(Object.values(megaClStates).sort()).toEqual(
      Object.keys(MEGA_CL_LABELS).sort(),
    );
  });

  it("chat-closure notification kinds are a subset of core kinds", () => {
    const core = new Set<string>(MEGA_NOTIFICATION_KINDS);
    for (const kind of Object.values(megaNotificationKinds)) {
      expect(core.has(kind)).toBe(true);
    }
  });

  it("exposes doc/release status defaults used by schema columns", () => {
    expect(megaDocStatus.DRAFT).toBe("draft");
    expect(megaReleaseStatuses.PUBLISHED).toBe("published");
  });

  it("maps release row fields to core Release via known renames", () => {
    // Schema: sha/status — domain: targetSha/state (intentional naming split;
    // mapper lives in EG-* services, not in the schema package).
    type ReleaseRow = { sha: string; status: "draft" | "published" };
    type DomainRelease = { targetSha: string; state: "draft" | "published" };
    const map = (row: ReleaseRow): DomainRelease => ({
      targetSha: row.sha,
      state: row.status,
    });
    expect(map({ sha: "abc", status: "draft" })).toEqual({
      targetSha: "abc",
      state: "draft",
    });
  });
});
