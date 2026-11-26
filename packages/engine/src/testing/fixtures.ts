// megaui:libs/mega/fixtures/users.ts@0ff3a9d
// megaui:libs/mega/fixtures/docs.ts@0ff3a9d
// megaui:libs/mega/fixtures/cls.ts@0ff3a9d
// megaui:libs/mega/fixtures/chat.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-01 task card):
// - Test-domain only (DEBT-04): never imported from the package root barrel.
// - User drops fixture-only `status` / `team` (already stripped in @megaui/core).
// - Samples are a small representative set (users / one doc / one CL / one
//   channel + a few messages), not the full MEGA_FIXTURES dump.
// - No SaaS / mock-backend surfaces.
import type {
  CL,
  ChatMessage,
  Doc,
  User,
  WorkspaceChannel,
} from "@megaui/core";

export const FIXTURE_NOW = new Date("2026-04-19T10:24:00.000Z");

export function minutesAgo(minutes: number): string {
  return new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();
}

export const USERS = {
  tianjing: {
    id: "usr_tianjing",
    username: "tianjing",
    displayName: "Tianjing Ye",
    avatarInitials: "TY",
    avatarColor: "#7c3aed",
  },
  eleanor: {
    id: "usr_eleanor",
    username: "eleanor",
    displayName: "Eleanor Vance",
    avatarInitials: "EV",
    avatarColor: "#db2777",
  },
  rafael: {
    id: "usr_rafael",
    username: "rafael",
    displayName: "Rafael Ortiz",
    avatarInitials: "RO",
    avatarColor: "#059669",
  },
} as const satisfies Record<string, User>;

export const ALL_USERS: readonly User[] = Object.values(USERS);

export const CURRENT_USER = USERS.tianjing;

const EMPTY_EDITOR_STATE =
  '{"root":{"children":[],"direction":null,"format":"","indent":0,"type":"root","version":1}}';

const SAMPLE_CL_PUBLIC_ID = "Q7rE8kzpY_1A";

export const SAMPLE_DOC: Doc = {
  id: "doc_arch_overview",
  title: "Architecture overview",
  body: EMPTY_EDITOR_STATE,
  excerpt: "Workspace domain outline for local seed and tests.",
  author: USERS.tianjing,
  collaborators: [USERS.eleanor],
  tags: [{ id: "tag_design", name: "design" }],
  linkedCLs: [SAMPLE_CL_PUBLIC_ID],
  linkedIssues: [],
  versions: [
    {
      id: "doc_arch_overview_v1",
      version: 1,
      author: USERS.tianjing,
      createdAt: minutesAgo(240),
      summary: "Initial fixture import",
    },
  ],
  starred: true,
  preview: ["Workspace domain outline for local seed and tests."],
  status: "published",
  viewCount: 12,
  commentCount: 0,
  createdAt: minutesAgo(240),
  updatedAt: minutesAgo(120),
};

export const SAMPLE_DOCS: readonly Doc[] = [SAMPLE_DOC];

export const SAMPLE_CL: CL = {
  id: "cl_1",
  publicId: SAMPLE_CL_PUBLIC_ID,
  number: 1,
  title: "Introduce engine result contract",
  description: "Skeleton CL used by the engine seed and tests.",
  state: "ready",
  packageId: "pkg_engine",
  author: USERS.rafael,
  reviewers: [
    {
      user: USERS.tianjing,
      verdict: "approved",
      reviewedAt: minutesAgo(40),
    },
  ],
  additions: 24,
  deletions: 2,
  files: [],
  revisions: [],
  ci: "passing",
  merge: "needs-review",
  atomic: false,
  crossPackage: [],
  linkedIssues: [],
  branch: "eg-01-engine-base",
  subscribed: true,
  createdAt: minutesAgo(180),
  updatedAt: minutesAgo(40),
};

export const SAMPLE_CLS: readonly CL[] = [SAMPLE_CL];

export const SAMPLE_CHANNEL: WorkspaceChannel = {
  id: "chn_general",
  kind: "channel",
  visibility: "public",
  name: "general",
  topic: "Workspace-wide conversation",
  unreadCount: 0,
  mentionCount: 0,
};

export const SAMPLE_CHANNELS: readonly WorkspaceChannel[] = [SAMPLE_CHANNEL];

export const SAMPLE_MESSAGES: readonly ChatMessage[] = [
  {
    id: "msg_general_1",
    channelId: SAMPLE_CHANNEL.id,
    author: USERS.tianjing,
    createdAt: minutesAgo(90),
    reactions: [],
    segments: [{ type: "text", text: "Seed data is ready for local review." }],
  },
  {
    id: "msg_general_2",
    channelId: SAMPLE_CHANNEL.id,
    author: USERS.eleanor,
    createdAt: minutesAgo(80),
    reactions: [],
    segments: [
      { type: "text", text: "Noted — see " },
      { type: "cl-ref", publicId: SAMPLE_CL.publicId },
      { type: "text", text: "." },
    ],
  },
  {
    id: "msg_general_3",
    channelId: SAMPLE_CHANNEL.id,
    author: USERS.rafael,
    createdAt: minutesAgo(70),
    reactions: [{ emoji: "👍", count: 1, reactedByMe: false }],
    segments: [{ type: "text", text: "I will merge after the review round." }],
  },
];
