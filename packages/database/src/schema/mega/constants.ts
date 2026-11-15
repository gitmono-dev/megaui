// megaui:libs/database/constants.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-05 task card): only the
// mega_* vocabulary constants used by content schema defaults are kept.
// SaaS/billing/blog/order/subscription constants are omitted (SaaS 剥离).
// Auth `userRoles` lives with better-auth admin fields (PK-04/PK-06), not here.

/** Mega content-container kinds (ADR-CE-03). */
export const megaContentContainerTypes = {
  DOC: "doc",
  ISSUE: "issue",
  CL: "cl",
  ISSUE_COMMENT: "issue_comment",
  CL_COMMENT: "cl_comment",
  INLINE_COMMENT: "inline_comment",
  REPLY: "reply",
  CHAT_MESSAGE: "chat_message",
  AGENT_MESSAGE: "agent_message",
  RELEASE_NOTE: "release_note",
  DOC_COMMENT: "doc_comment",
} as const;

export type MegaContentContainerType =
  (typeof megaContentContainerTypes)[keyof typeof megaContentContainerTypes];

export const megaContentLinkTargetKinds = {
  DOC: "doc",
  ISSUE: "issue",
  CL: "cl",
  BLOCK: "block",
} as const;

export type MegaContentLinkTargetKind =
  (typeof megaContentLinkTargetKinds)[keyof typeof megaContentLinkTargetKinds];

export const megaContentBlockVariants = {
  BULLET: "bullet",
  NUMBERED: "numbered",
  TODO: "todo",
  PARAGRAPH: "paragraph",
  QUOTE: "quote",
  CODE: "code",
  HEADING: "heading",
} as const;

export type MegaContentBlockVariant =
  (typeof megaContentBlockVariants)[keyof typeof megaContentBlockVariants];

export const megaDocStatus = {
  DRAFT: "draft",
  PUBLISHED: "published",
} as const;

export type MegaDocStatus = (typeof megaDocStatus)[keyof typeof megaDocStatus];

export const megaDocCollaboratorRoles = {
  OWNER: "owner",
  EDITOR: "editor",
  VIEWER: "viewer",
} as const;

export type MegaDocCollaboratorRole =
  (typeof megaDocCollaboratorRoles)[keyof typeof megaDocCollaboratorRoles];

export const megaIssueStates = {
  OPEN: "open",
  CLOSED: "closed",
} as const;

export type MegaIssueState = (typeof megaIssueStates)[keyof typeof megaIssueStates];

export const megaIssuePriorities = {
  P0: "P0",
  P1: "P1",
  P2: "P2",
  P3: "P3",
  P4: "P4",
} as const;

export type MegaIssuePriority =
  (typeof megaIssuePriorities)[keyof typeof megaIssuePriorities];

export const megaClStates = {
  READY: "ready",
  WIP: "wip",
  QUEUED: "queued",
  MERGED: "merged",
  CLOSED: "closed",
  CONFLICTS: "conflicts",
} as const;

export type MegaClState = (typeof megaClStates)[keyof typeof megaClStates];

export const megaClMergeStates = {
  QUEUE_READY: "queue-ready",
  NEEDS_REVIEW: "needs-review",
  IN_QUEUE: "in-queue",
  MERGED: "merged",
  REBASE_NEEDED: "rebase-needed",
} as const;

export type MegaClMergeState =
  (typeof megaClMergeStates)[keyof typeof megaClMergeStates];

export const megaClCiStatuses = {
  PASSING: "passing",
  FAILING: "failing",
  QUEUED: "queued",
  RUNNING: "running",
  SKIPPED: "skipped",
} as const;

export type MegaClCiStatus =
  (typeof megaClCiStatuses)[keyof typeof megaClCiStatuses];

export const megaChannelKinds = {
  PUBLIC: "public",
  PRIVATE: "private",
  DM: "dm",
} as const;

export type MegaChannelKind =
  (typeof megaChannelKinds)[keyof typeof megaChannelKinds];

export const megaChannelMemberRoles = {
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export type MegaChannelMemberRole =
  (typeof megaChannelMemberRoles)[keyof typeof megaChannelMemberRoles];

export const megaNotificationKinds = {
  MENTION: "mention",
  REPLY: "reply",
  DM: "dm",
  INVITE: "invite",
} as const;

export type MegaNotificationKind =
  (typeof megaNotificationKinds)[keyof typeof megaNotificationKinds];

export const megaReleaseStatuses = {
  DRAFT: "draft",
  PUBLISHED: "published",
} as const;

export type MegaReleaseStatus =
  (typeof megaReleaseStatuses)[keyof typeof megaReleaseStatuses];
