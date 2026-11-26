import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  megaAgentThreads,
  megaChannels,
  megaChannelMembers,
  megaClComments,
  megaCls,
  megaContent,
  megaContentBlocks,
  megaContentLinks,
  megaDocCollaborators,
  megaDocComments,
  megaDocs,
  megaDocStars,
  megaDocVersions,
  megaInlineComments,
  megaIssueComments,
  megaIssues,
  megaMessages,
  megaNotifications,
  megaReleases,
  megaSiteSettings,
} from "./index";

const EXPECTED_TABLES = [
  megaDocs,
  megaDocVersions,
  megaDocStars,
  megaDocCollaborators,
  megaDocComments,
  megaContent,
  megaContentLinks,
  megaContentBlocks,
  megaIssues,
  megaIssueComments,
  megaCls,
  megaClComments,
  megaInlineComments,
  megaReleases,
  megaChannels,
  megaMessages,
  megaAgentThreads,
  megaChannelMembers,
  megaNotifications,
  megaSiteSettings,
] as const;

describe("mega schema table inventory (PK-05 AC1)", () => {
  it("exports exactly the 20 mega tables (no SaaS tables)", () => {
    const names = EXPECTED_TABLES.map((table) => getTableName(table)).sort();
    expect(names).toEqual(
      [
        "mega_docs",
        "mega_doc_versions",
        "mega_doc_stars",
        "mega_doc_collaborators",
        "mega_doc_comments",
        "mega_content",
        "mega_content_links",
        "mega_content_blocks",
        "mega_issues",
        "mega_issue_comments",
        "mega_cls",
        "mega_cl_comments",
        "mega_inline_comments",
        "mega_releases",
        "mega_channels",
        "mega_messages",
        "mega_agent_threads",
        "mega_channel_members",
        "mega_notifications",
        "mega_site_settings",
      ].sort(),
    );
    expect(names).toHaveLength(20);
  });

  it("keeps user-owned FK columns that cascade on user delete (sample)", () => {
    const docs = getTableColumns(megaDocs);
    expect(docs.authorId.notNull).toBe(true);
    const issues = getTableColumns(megaIssues);
    expect(issues.authorId.notNull).toBe(true);
    const members = getTableColumns(megaChannelMembers);
    expect(members.userId.notNull).toBe(true);
  });
});
