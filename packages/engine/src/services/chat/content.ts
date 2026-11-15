// megaui:libs/mega/services/repos/chat-repo.ts@0ff3a9d
//
// megaui-only additions (registered on the EG-07 task card): `mega_messages`
// stores authoring/reaction metadata only — message segments and thread-routing
// metadata (`threadId` / `rootMessageId` / `participantIds`) live in
// `mega_content` under container type `chat_message` with `containerId =
// message.id` (schema header comment on `mega-chat.ts`, PK-05). This is the
// same envelope upstream's `chat-repo.ts` (`packChatContentBody`) writes,
// minus the Lexical `root` key — see `./types.ts` diff header for why no
// Lexical body is ported.
import { and, eq } from "drizzle-orm";
import { megaContent, megaContentContainerTypes, type Database } from "@megaui/database";
import type { ChatSegment } from "@megaui/core";

export interface ChatContentEnvelope {
  segments: ChatSegment[];
  threadId?: string;
  rootMessageId?: string;
  participantIds?: string[];
}

function parseSegments(raw: unknown): ChatSegment[] {
  return Array.isArray(raw) ? (raw as ChatSegment[]) : [];
}

function parseStringArray(raw: unknown): string[] | undefined {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : undefined;
}

function parseEnvelope(raw: unknown): ChatContentEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { segments: [] };
  const body = raw as Record<string, unknown>;
  return {
    segments: parseSegments(body.segments),
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
    rootMessageId: typeof body.rootMessageId === "string" ? body.rootMessageId : undefined,
    participantIds: parseStringArray(body.participantIds),
  };
}

export async function readChatContent(
  database: Database,
  messageId: string,
): Promise<ChatContentEnvelope> {
  const [row] = await database
    .select({ bodyJson: megaContent.bodyJson })
    .from(megaContent)
    .where(
      and(
        eq(megaContent.containerType, megaContentContainerTypes.CHAT_MESSAGE),
        eq(megaContent.containerId, messageId),
      ),
    )
    .limit(1);
  return parseEnvelope(row?.bodyJson);
}

export async function writeChatContent(
  tx: Database,
  messageId: string,
  envelope: ChatContentEnvelope,
  now: Date,
): Promise<void> {
  const bodyJson: Record<string, unknown> = { segments: envelope.segments };
  if (envelope.threadId) bodyJson.threadId = envelope.threadId;
  if (envelope.rootMessageId) bodyJson.rootMessageId = envelope.rootMessageId;
  if (envelope.participantIds) bodyJson.participantIds = envelope.participantIds;
  await tx
    .insert(megaContent)
    .values({
      containerType: megaContentContainerTypes.CHAT_MESSAGE,
      containerId: messageId,
      bodyJson,
      bodyFormatVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [megaContent.containerType, megaContent.containerId],
      set: { bodyJson, updatedAt: now },
    });
}
