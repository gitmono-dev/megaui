// megaui:libs/mega/services/members.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-02 task card):
// - No mock store / MEGA_CHAT_DATA_BACKEND switch (DEBT-04).
// - No ensureMockWorkspaceUser.
// - Invite does not fan out notifications (EG-09).
// - Explicit Database injection (no process-wide db singleton).
// - Removing the last channel admin is denied (card AC: 移除 owner).
// - DM channel ids are a sha256 of the NUL-joined sorted user pair (not
//   `dm_${a}_${b}`), so IDs containing `_` cannot collide.
// - Unauthenticated actors throw MegaUnauthorizedError (401), not Forbidden.
import { createHash, randomUUID } from "node:crypto";
import type { Channel, ChannelMember, DirectMessageChannel, User, WorkspaceChannel } from "@megaui/core";
import {
  megaChannelKinds,
  megaChannelMemberRoles,
  megaChannelMembers,
  megaChannels,
  type Database,
} from "@megaui/database";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  MegaBadRequestError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../errors";
import { fallbackPublicProfile, resolvePublicProfiles } from "./public-profile";

export type ChannelAccessDecision = {
  allow: boolean;
  reason: "public_workspace" | "member" | "not_member" | "unauthenticated" | "missing";
};

export type CreateChannelInput = {
  name: string;
  visibility: "public" | "private";
  topic?: string;
};

export type InviteMemberInput = {
  channelId: string;
  userId: string;
  actorUserId: string;
};

function isPgUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : undefined;
  }
  return false;
}

/** Collision-free DM id: sha256 of sorted user ids joined by NUL (not `dm_a_b`). */
export function dmChannelId(userA: string, userB: string): string {
  const left = userA < userB ? userA : userB;
  const right = userA < userB ? userB : userA;
  const digest = createHash("sha256")
    .update(left, "utf8")
    .update("\0")
    .update(right, "utf8")
    .digest("hex");
  return `dm_${digest}`;
}

export function createMembersService(database: Database) {
  async function dbChannelKind(channelId: string): Promise<string | null> {
    const [row] = await database
      .select({ kind: megaChannels.kind })
      .from(megaChannels)
      .where(eq(megaChannels.id, channelId))
      .limit(1);
    return row?.kind ?? null;
  }

  async function dbIsMember(channelId: string, userId: string): Promise<boolean> {
    const [row] = await database
      .select({ id: megaChannelMembers.id })
      .from(megaChannelMembers)
      .where(
        and(
          eq(megaChannelMembers.channelId, channelId),
          eq(megaChannelMembers.userId, userId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async function resolveUser(userId: string): Promise<User> {
    const resolved = (await resolvePublicProfiles(database, [userId])).get(userId);
    if (!resolved) throw new MegaNotFoundError("User", userId);
    return resolved;
  }

  async function canAccessChannel(
    channelId: string,
    userId: string | null | undefined,
  ): Promise<ChannelAccessDecision> {
    if (!userId?.trim()) return { allow: false, reason: "unauthenticated" };
    const kind = await dbChannelKind(channelId);
    if (!kind) return { allow: false, reason: "missing" };
    if (kind === megaChannelKinds.PUBLIC) {
      return { allow: true, reason: "public_workspace" };
    }
    if (await dbIsMember(channelId, userId)) return { allow: true, reason: "member" };
    return { allow: false, reason: "not_member" };
  }

  async function assertCanAccessChannel(
    channelId: string,
    userId: string | null | undefined,
  ): Promise<void> {
    const decision = await canAccessChannel(channelId, userId);
    if (decision.reason === "missing") throw new MegaNotFoundError("Channel", channelId);
    if (decision.reason === "unauthenticated") {
      throw new MegaUnauthorizedError("A signed-in session is required");
    }
    if (!decision.allow) throw new MegaForbiddenError("Channel access denied");
  }

  async function filterChannelsForActor(
    channels: readonly Channel[],
    userId: string | null | undefined,
  ): Promise<Channel[]> {
    if (!userId?.trim() || channels.length === 0) return [];
    const ids = channels.map((channel) => channel.id);
    const kindRows = await database
      .select({ id: megaChannels.id, kind: megaChannels.kind })
      .from(megaChannels)
      .where(inArray(megaChannels.id, ids));
    const kindById = new Map(kindRows.map((row) => [row.id, row.kind]));
    const memberRows = await database
      .select({ channelId: megaChannelMembers.channelId })
      .from(megaChannelMembers)
      .where(
        and(
          inArray(megaChannelMembers.channelId, ids),
          eq(megaChannelMembers.userId, userId),
        ),
      );
    const memberSet = new Set(memberRows.map((row) => row.channelId));
    return channels.filter((channel) => {
      const kind = kindById.get(channel.id);
      if (!kind) return false;
      if (kind === megaChannelKinds.PUBLIC) return true;
      return memberSet.has(channel.id);
    });
  }

  async function listChannelMembers(
    channelId: string,
    actorUserId: string | null | undefined,
  ): Promise<ChannelMember[]> {
    await assertCanAccessChannel(channelId, actorUserId);
    const rows = await database
      .select({
        id: megaChannelMembers.id,
        channelId: megaChannelMembers.channelId,
        userId: megaChannelMembers.userId,
        role: megaChannelMembers.role,
        lastReadMessageId: megaChannelMembers.lastReadMessageId,
        muted: megaChannelMembers.muted,
        joinedAt: megaChannelMembers.joinedAt,
      })
      .from(megaChannelMembers)
      .where(eq(megaChannelMembers.channelId, channelId))
      .orderBy(asc(megaChannelMembers.joinedAt));
    const publicUsers = await resolvePublicProfiles(
      database,
      rows.map((row) => row.userId),
    );

    return rows.map((row) => ({
      id: row.id,
      channelId: row.channelId,
      userId: row.userId,
      user: publicUsers.get(row.userId) ?? fallbackPublicProfile(row.userId),
      role: row.role === megaChannelMemberRoles.ADMIN ? "admin" : "member",
      lastReadMessageId: row.lastReadMessageId ?? undefined,
      muted: row.muted,
      joinedAt:
        row.joinedAt instanceof Date
          ? row.joinedAt.toISOString()
          : String(row.joinedAt),
    } satisfies ChannelMember));
  }

  async function inviteChannelMember(input: InviteMemberInput): Promise<ChannelMember> {
    const { channelId, userId, actorUserId } = input;
    if (!actorUserId.trim()) throw new MegaUnauthorizedError("A signed-in session is required");
    await assertCanAccessChannel(channelId, actorUserId);

    const kind = await dbChannelKind(channelId);
    if (!kind) throw new MegaNotFoundError("Channel", channelId);
    if (kind === megaChannelKinds.DM) {
      throw new MegaBadRequestError("Cannot invite to a DM channel");
    }

    const invited = await resolveUser(userId);
    const id = `chmem_${randomUUID()}`;
    const now = new Date();

    // Lock membership rows so a concurrent demote/remove of the actor cannot
    // race past the admin check into a still-allowed insert (GC-07/GC-08).
    await database.transaction(async (tx) => {
      const rows = await tx
        .select({
          userId: megaChannelMembers.userId,
          role: megaChannelMembers.role,
        })
        .from(megaChannelMembers)
        .where(eq(megaChannelMembers.channelId, channelId))
        .orderBy(asc(megaChannelMembers.userId))
        .for("update");

      const actor = rows.find((row) => row.userId === actorUserId);
      if (!actor || actor.role !== megaChannelMemberRoles.ADMIN) {
        throw new MegaForbiddenError("Admin role required");
      }
      if (rows.some((row) => row.userId === userId)) {
        throw new MegaBadRequestError("User is already a member");
      }

      try {
        await tx.insert(megaChannelMembers).values({
          id,
          channelId,
          userId,
          role: megaChannelMemberRoles.MEMBER,
          muted: false,
          joinedAt: now,
        });
      } catch (error) {
        if (isPgUniqueViolation(error)) {
          throw new MegaBadRequestError("User is already a member");
        }
        throw error;
      }
    });

    return {
      id,
      channelId,
      userId,
      user: invited,
      role: "member",
      muted: false,
      joinedAt: now.toISOString(),
    };
  }

  async function removeChannelMember(
    channelId: string,
    targetUserId: string,
    actorUserId: string | null | undefined,
  ): Promise<{ removed: true }> {
    if (!actorUserId?.trim()) throw new MegaUnauthorizedError("A signed-in session is required");
    await assertCanAccessChannel(channelId, actorUserId);

    const kind = await dbChannelKind(channelId);
    if (!kind) throw new MegaNotFoundError("Channel", channelId);
    if (kind === megaChannelKinds.DM) {
      throw new MegaBadRequestError("Cannot remove members from a DM");
    }

    // Lock all membership rows for this channel so concurrent removals cannot
    // both observe adminCount > 1 and leave the channel with zero admins (GC-08).
    return database.transaction(async (tx) => {
      const rows = await tx
        .select({
          userId: megaChannelMembers.userId,
          role: megaChannelMembers.role,
        })
        .from(megaChannelMembers)
        .where(eq(megaChannelMembers.channelId, channelId))
        .orderBy(asc(megaChannelMembers.userId))
        .for("update");

      const actor = rows.find((row) => row.userId === actorUserId);
      if (!actor) throw new MegaForbiddenError("Channel access denied");
      const isSelfLeave = targetUserId === actorUserId;
      if (!isSelfLeave && actor.role !== megaChannelMemberRoles.ADMIN) {
        throw new MegaForbiddenError("Admin role required");
      }

      const target = rows.find((row) => row.userId === targetUserId);
      if (!target) throw new MegaNotFoundError("Channel member", targetUserId);
      const adminCount = rows.filter(
        (row) => row.role === megaChannelMemberRoles.ADMIN,
      ).length;
      if (target.role === megaChannelMemberRoles.ADMIN && adminCount <= 1) {
        throw new MegaBadRequestError("Cannot remove the last channel admin");
      }

      const deleted = await tx
        .delete(megaChannelMembers)
        .where(
          and(
            eq(megaChannelMembers.channelId, channelId),
            eq(megaChannelMembers.userId, targetUserId),
          ),
        )
        .returning({ id: megaChannelMembers.id });
      if (!deleted.length) throw new MegaNotFoundError("Channel member", targetUserId);
      return { removed: true as const };
    });
  }

  async function leaveChannel(
    channelId: string,
    actorUserId: string | null | undefined,
  ): Promise<{ removed: true }> {
    if (!actorUserId?.trim()) throw new MegaUnauthorizedError("A signed-in session is required");
    return removeChannelMember(channelId, actorUserId, actorUserId);
  }

  async function createChannel(
    input: CreateChannelInput,
    actorUserId: string | null | undefined,
  ): Promise<WorkspaceChannel> {
    const adminUserId = actorUserId?.trim();
    if (!adminUserId) throw new MegaUnauthorizedError("A signed-in session is required");
    const name = input.name.trim();
    if (!name) throw new MegaBadRequestError("Channel name is required");
    if (input.visibility !== "public" && input.visibility !== "private") {
      throw new MegaBadRequestError("Invalid channel visibility");
    }
    const topic = input.topic?.trim() || undefined;
    const id = `channel_${randomUUID()}`;
    const now = new Date();
    const kind =
      input.visibility === "private"
        ? megaChannelKinds.PRIVATE
        : megaChannelKinds.PUBLIC;
    await database.transaction(async (tx) => {
      await tx.insert(megaChannels).values({
        id,
        kind,
        name,
        topic: topic ?? null,
        participantIds: [],
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(megaChannelMembers).values({
        id: `chmem_${randomUUID()}`,
        channelId: id,
        userId: adminUserId,
        role: megaChannelMemberRoles.ADMIN,
        muted: false,
        joinedAt: now,
      });
    });
    return {
      id,
      name,
      kind: "channel",
      visibility: input.visibility,
      topic,
      unreadCount: 0,
      mentionCount: 0,
    };
  }

  async function getPeerLastReadMessageId(
    channelId: string,
    selfUserId: string,
  ): Promise<string | undefined> {
    const [row] = await database
      .select({ lastReadMessageId: megaChannelMembers.lastReadMessageId })
      .from(megaChannelMembers)
      .where(
        and(
          eq(megaChannelMembers.channelId, channelId),
          ne(megaChannelMembers.userId, selfUserId),
        ),
      )
      .limit(1);
    return row?.lastReadMessageId ?? undefined;
  }

  async function openOrCreateDm(
    peerUserId: string,
    actorUserId: string,
  ): Promise<DirectMessageChannel> {
    if (!actorUserId.trim()) throw new MegaUnauthorizedError("A signed-in session is required");
    if (!peerUserId.trim()) throw new MegaBadRequestError("Peer userId is required");
    if (peerUserId === actorUserId) {
      throw new MegaBadRequestError("Cannot open a DM with yourself");
    }
    const peer = await resolveUser(peerUserId);
    await resolveUser(actorUserId);
    const channelId = dmChannelId(actorUserId, peerUserId);
    const now = new Date();
    await database.transaction(async (tx) => {
      await tx
        .insert(megaChannels)
        .values({
          id: channelId,
          kind: megaChannelKinds.DM,
          name: peer.displayName,
          topic: null,
          participantIds: [actorUserId, peerUserId],
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      for (const userId of [actorUserId, peerUserId]) {
        await tx
          .insert(megaChannelMembers)
          .values({
            id: `chmem_${randomUUID()}`,
            channelId,
            userId,
            role: megaChannelMemberRoles.MEMBER,
            muted: false,
            joinedAt: now,
          })
          .onConflictDoNothing();
      }
    });
    return {
      id: channelId,
      name: peer.displayName,
      kind: "dm",
      participant: peer,
      unreadCount: 0,
      mentionCount: 0,
      participantLastReadMessageId: await getPeerLastReadMessageId(
        channelId,
        actorUserId,
      ),
    };
  }

  return {
    canAccessChannel,
    assertCanAccessChannel,
    filterChannelsForActor,
    listChannelMembers,
    inviteChannelMember,
    removeChannelMember,
    leaveChannel,
    createChannel,
    openOrCreateDm,
  };
}

export type MembersService = ReturnType<typeof createMembersService>;
