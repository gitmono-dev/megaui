// megaui:libs/mega/services/home.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-07):
// - Aggregates live engine domains instead of the in-memory mock store.
// - Main-branch CI is unavailable until a repository-scoped, authorized source is wired.
// - Actor-scoped: reviews/issues/mentions use the signed-in user, not CURRENT_USER.

import type { Channel, CL, User } from "@megaui/core";
import { isOpenCLState } from "@megaui/core";
import { MAX_PAGE_LIMIT } from "@megaui/engine";
import { isOrion2Configured } from "@megaui/engine/services/orion2";

import {
  getAgentDomain,
  getChatDomain,
  getDocsDomain,
  getIssuesDomain,
  getNotificationsDomain,
  getReleasesDomain,
} from "@/lib/engine";

import { listWorkspaceCLs } from "./cl-list";

export interface HomeKpis {
  reviewsRequested: number;
  mentions: number;
  myOpenIssues: number;
  mainCI: "passing" | "failing" | "queued" | "running" | "skipped" | "unconfigured" | "unavailable";
  agentSessionsToday: number;
}

export interface HomeDashboard {
  kpis: HomeKpis;
  cards: {
    reviewRequests: readonly {
      publicId: string;
      number: number;
      title: string;
      state: CL["state"];
      author: User;
    }[];
    recentCls: readonly Pick<CL, "publicId" | "title">[];
    assignedIssues: readonly { number: number; title: string; priority: string }[];
    activity: readonly {
      id: string;
      actorName: string;
      author: Pick<User, "id" | "username" | "displayName" | "avatarInitials">;
      entityRef: string;
      title: string;
      kind: "updated";
      createdAt: string;
    }[];
    releases: readonly { id: string; tag: string; title: string; publishedAt?: string }[];
    agentThreads: readonly { id: string; title: string; updatedAt: string }[];
    docs: readonly { id: string; title: string; updatedAt: string }[];
    channels: readonly (Pick<
      Extract<Channel, { kind: "channel" }>,
      "id" | "name" | "kind" | "unreadCount" | "mentionCount"
    > & { lastMessageAt?: string })[];
    quickLinks: readonly {
      id: string;
      kind: "agent" | "doc" | "issue" | "cl" | "release" | "channel";
      href: string;
    }[];
  };
}

const PAGE = { pagination: { limit: MAX_PAGE_LIMIT, offset: 0 } };

export async function getHomeDashboard(actorUserId: string | null, headers: Headers): Promise<HomeDashboard> {
  const actor = actorUserId?.trim() || "";
  const { issues } = getIssuesDomain();
  const docsDomain = getDocsDomain();
  const { chat } = getChatDomain();
  const { notifications } = getNotificationsDomain();
  const { releases } = getReleasesDomain();
  const { agent } = getAgentDomain();

  const [issuePage, clRows, docs, channels, notificationPage, releasePage, threadPage] =
    await Promise.all([
      issues.listIssues(PAGE, actor || null),
      listWorkspaceCLs({}, actor, headers),
      docsDomain.docs.listDocs(actor || null),
      chat.listChannels(actor || null),
      actor
        ? notifications.listNotifications(actor, PAGE)
        : Promise.resolve({ items: [] as { kind: string; readAt?: string }[] }),
      releases.listReleases(PAGE),
      agent.listThreads(PAGE),
    ]);

  const mentions = notificationPage.items.filter(
    (row) => row.kind === "mention" && !row.readAt,
  );
  const myOpenIssues = issuePage.items.filter(
    (issue) =>
      issue.state === "open" &&
      actor &&
      issue.assignees.some((assignee) => assignee.id === actor),
  );
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const agentThreadsToday = threadPage.items.filter(
    (thread) => Date.parse(thread.updatedAt) >= todayStart.getTime(),
  );
  const orderedCLs = [...clRows].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const reviewRequests = orderedCLs.filter(
    (cl) =>
      isOpenCLState(cl.state) &&
      actor &&
      cl.reviewers.some(
        (reviewer) =>
          reviewer.user.id === actor &&
          (reviewer.verdict === "requested" || reviewer.verdict === "pending"),
      ),
  );
  const assignedIssues = [...myOpenIssues].sort(
    (left, right) =>
      left.priority.localeCompare(right.priority) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const orderedDocs = [...docs].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const orderedThreads = [...threadPage.items].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const orderedReleases = [...releasePage.items].sort((left, right) =>
    (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
  );
  const workspaceChannels = channels.filter(
    (channel): channel is Extract<Channel, { kind: "channel" }> =>
      channel.kind === "channel",
  );
  const firstReview = reviewRequests[0];
  const firstIssue = assignedIssues[0];
  const firstDoc = orderedDocs[0];
  const firstAgentThread = orderedThreads[0];
  const firstRelease = orderedReleases[0];
  const firstChannel = workspaceChannels[0];

  return {
    kpis: {
      reviewsRequested: reviewRequests.length,
      mentions: mentions.length,
      myOpenIssues: myOpenIssues.length,
      mainCI: isOrion2Configured(process.env) ? "unavailable" : "unconfigured",
      agentSessionsToday: agentThreadsToday.length,
    },
    cards: {
      reviewRequests: reviewRequests.slice(0, 3).map((cl) => ({
        publicId: cl.publicId,
        number: cl.number,
        title: cl.title,
        state: cl.state,
        author: cl.author,
      })),
      recentCls: orderedCLs.slice(0, 3).map(({ publicId, title }) => ({ publicId, title })),
      assignedIssues: assignedIssues.slice(0, 3).map((issue) => ({
        number: issue.number,
        title: issue.title,
        priority: issue.priority,
      })),
      activity: orderedCLs.slice(0, 5).map((cl) => ({
        id: `cl_${cl.number}`,
        actorName: cl.author.displayName,
        author: {
          id: cl.author.id, username: cl.author.username,
          displayName: cl.author.displayName, avatarInitials: cl.author.avatarInitials,
        },
        entityRef: cl.publicId,
        title: cl.title,
        kind: "updated" as const,
        createdAt: cl.updatedAt,
      })),
      releases: orderedReleases.slice(0, 4).map((release) => ({
        id: release.id,
        tag: release.tag,
        title: release.title,
        publishedAt: release.publishedAt,
      })),
      agentThreads: orderedThreads.slice(0, 4).map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      })),
      docs: orderedDocs.slice(0, 4).map((doc) => ({
        id: doc.id,
        title: doc.title,
        updatedAt: doc.updatedAt,
      })),
      channels: workspaceChannels.slice(0, 4).map((channel) => ({
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        unreadCount: channel.unreadCount,
        mentionCount: channel.mentionCount,
      })),
      quickLinks: [
        firstAgentThread && {
          id: `agent_${firstAgentThread.id}`,
          kind: "agent" as const,
          href: `/workspace/agent/${firstAgentThread.id}`,
        },
        firstDoc && {
          id: `doc_${firstDoc.id}`,
          kind: "doc" as const,
          href: `/workspace/docs/${firstDoc.id}`,
        },
        firstIssue && {
          id: `issue_${firstIssue.number}`,
          kind: "issue" as const,
          href: `/workspace/issues/${firstIssue.number}`,
        },
        firstReview && {
          id: `cl_${firstReview.number}`,
          kind: "cl" as const,
          href: `/workspace/cls/${firstReview.publicId}`,
        },
        firstRelease && {
          id: `release_${firstRelease.id}`,
          kind: "release" as const,
          href: "/workspace/tags",
        },
        firstChannel && {
          id: `channel_${firstChannel.id}`,
          kind: "channel" as const,
          href: `/workspace/channels/${firstChannel.id}`,
        },
      ].filter(
        (
          link,
        ): link is {
          id: string;
          kind: "agent" | "doc" | "issue" | "cl" | "release" | "channel";
          href: string;
        } => Boolean(link),
      ),
    },
  };
}
