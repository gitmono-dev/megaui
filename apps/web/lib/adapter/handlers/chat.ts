// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (chat segments)

import { MegaForbiddenError } from "@megaui/engine";
import { z } from "zod";

import { getChatDomain } from "@/lib/engine";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { invalidRoute, only, segmentText } from "./shared";

const segmentsSchema = z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("code"), language: z.string().optional(), text: z.string() }),
  z.object({ type: z.literal("link"), url: z.string(), text: z.string() }),
  z.object({ type: z.literal("cl-ref"), number: z.number().int().positive() }),
  z.object({ type: z.literal("issue-ref"), number: z.number().int().positive() }),
  z.object({ type: z.literal("user-ref"), username: z.string().trim().min(1) }),
  z.object({ type: z.literal("file-ref"), path: z.string().trim().min(1), line: z.number().int().positive().optional() }),
])).min(1);

const chatMessageSchema = z.object({
  body: z.string().optional(),
  segments: segmentsSchema.optional(),
}).refine(
  (data) => Boolean(data.body?.trim()) || (data.segments !== undefined && data.segments.length > 0),
  { message: "Message body or segments are required" },
);

const editChatMessageSchema = z.object({
  body: z.string().min(1),
});

async function dispatchChatGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { chat } = getChatDomain();

  if (only(segments, ["channels"])) {
    return chat.listChannels(actorUserId);
  }
  if (segments[0] === "channels" && segments[2] === "members" && segments.length === 3) {
    return chat.listChannelMembers(segmentText(segments[1]), actorUserId);
  }
  if (segments[0] === "channels" && segments[2] === "messages" && segments.length === 3) {
    return chat.listChatMessages(segmentText(segments[1]), actorUserId);
  }
  if (segments[0] === "chat-threads" && segments.length === 2) {
    const thread = await chat.getChatThread(segmentText(segments[1]), actorUserId);
    return thread;
  }
  if (segments[0] === "channels" && segments[2] === "threads" && segments.length === 3) {
    return chat.listChatThreads(segmentText(segments[1]), actorUserId);
  }

  return invalidRoute(segments);
}

async function dispatchChatPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { chat } = getChatDomain();

  if (only(segments, ["channels"])) {
    const input = z.object({
      name: z.string().trim().min(1),
      visibility: z.enum(["public", "private"]),
      topic: z.string().trim().optional(),
    }).parse(body);
    return chat.createChannel(input, actorUserId);
  }
  if (only(segments, ["channels", "dm"])) {
    if (!actorUserId) throw new MegaForbiddenError("Authenticated user required");
    return chat.openOrCreateDm(
      z.object({ userId: z.string().trim().min(1) }).parse(body).userId,
      actorUserId,
    );
  }
  if (segments[0] === "channels" && segments[2] === "messages" && segments.length === 3) {
    const parsed = chatMessageSchema.parse(body);
    const messageSegments = parsed.segments ?? [{ type: "text" as const, text: parsed.body!.trim() }];
    return chat.sendChatMessage({
      channelId: segmentText(segments[1]),
      segments: messageSegments,
    }, actorUserId);
  }
  if (segments[0] === "channels" && segments[2] === "members" && segments[3] === "invite" && segments.length === 4) {
    if (!actorUserId) throw new MegaForbiddenError("Authenticated user required");
    return chat.inviteChannelMember({
      channelId: segmentText(segments[1]),
      userId: z.object({ userId: z.string().trim().min(1) }).parse(body).userId,
      actorUserId,
    });
  }
  if (segments[0] === "channels" && segments[2] === "members" && segments[3] === "leave" && segments.length === 4) {
    return chat.leaveChannel(segmentText(segments[1]), actorUserId);
  }
  if (segments[0] === "chat-threads" && segments[2] === "reply" && segments.length === 3) {
    const parsed = chatMessageSchema.parse(body);
    const messageSegments = parsed.segments ?? [{ type: "text" as const, text: parsed.body!.trim() }];
    return chat.replyToChatThread(segmentText(segments[1]), {
      segments: messageSegments,
    }, actorUserId);
  }
  if (segments[0] === "chat-messages" && segments[2] === "edit" && segments.length === 3) {
    const editedBody = editChatMessageSchema.parse(body).body;
    return chat.editChatMessage(
      segmentText(segments[1]),
      { segments: [{ type: "text", text: editedBody }] },
      actorUserId,
    );
  }
  if (segments[0] === "channels" && segments[2] === "read" && segments.length === 3) {
    return chat.markChannelRead(segmentText(segments[1]), actorUserId);
  }
  if (segments[0] === "chat-messages" && segments[2] === "reactions" && segments.length === 3) {
    return chat.toggleMessageReaction(
      segmentText(segments[1]),
      z.object({ emoji: z.string().trim().min(1) }).parse(body).emoji,
      actorUserId,
    );
  }

  return invalidRoute(segments);
}

async function dispatchChatDelete(context: MegaDispatchContext): Promise<unknown> {
  const { segments, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { chat } = getChatDomain();

  if (segments[0] === "channels" && segments[2] === "members" && segments.length === 4) {
    return chat.removeChannelMember(
      segmentText(segments[1]),
      segmentText(segments[3]),
      actorUserId,
    );
  }

  return invalidRoute(segments);
}

function matchesChatRoutes(segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  const head = segments[0];
  return head === "channels" || head === "chat-threads" || head === "chat-messages";
}

registerMegaRoute({
  match: (_method, segments) => matchesChatRoutes(segments),
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchChatGet(context);
      case "POST":
        return dispatchChatPost(context);
      case "DELETE":
        return dispatchChatDelete(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
