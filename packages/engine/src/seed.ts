// megaui:libs/mega/services/seed-mega.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-01 task card):
// - No MEGA_*_DATA_BACKEND mock switch (DEBT-04: runtime never falls back
//   to fixtures). This CLI writes fixture *rows* into a real PG.
// - No SaaS tables (blog/order/subscription/…).
// - No markdown-outline import, FTS rebuild, or mega2 commit probe —
//   those belong to later EG-* cards. Bodies use the content empty-doc JSON
//   (docs/CL) or a chat-segment envelope (messages).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import {
  createDatabaseClient,
  megaChannels,
  megaChannelMembers,
  megaChannelMemberRoles,
  megaChannelKinds,
  megaCls,
  megaClStates,
  megaClPublicIds,
  megaClCiStatuses,
  megaClMergeStates,
  megaContent,
  megaContentContainerTypes,
  megaDocCollaborators,
  megaDocCollaboratorRoles,
  megaDocs,
  megaDocStars,
  megaDocStatus,
  megaDocVersions,
  megaMessages,
  user,
  type Database,
} from "@megaui/database";
import { eq } from "drizzle-orm";
import { ensureCLPublicId, lockCLNumberAllocation, nextCLNumber } from "./services/cls/public-id";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  ALL_USERS,
  SAMPLE_CHANNEL,
  SAMPLE_CL,
  SAMPLE_DOC,
  SAMPLE_MESSAGES,
  USERS,
} from "./testing/fixtures";

export interface SeedMegaResult {
  inserted: number;
  skipped: number;
}

class SeedCounter {
  inserted = 0;
  skipped = 0;

  noteInserted(count = 1): void {
    this.inserted += count;
  }

  noteSkipped(count = 1): void {
    this.skipped += count;
  }
}

async function insertOrSkip(
  counter: SeedCounter,
  rows: readonly unknown[],
): Promise<void> {
  if (rows.length > 0) counter.noteInserted(rows.length);
  else counter.noteSkipped(1);
}

function parseJsonBody(serialized: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[@megaui/engine] seed body JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

export async function seedMegaDatabase(database: Database): Promise<SeedMegaResult> {
  const counter = new SeedCounter();
  const now = new Date(SAMPLE_DOC.updatedAt);

  for (const fixtureUser of ALL_USERS) {
    const rows = await database
      .insert(user)
      .values({
        id: fixtureUser.id,
        name: fixtureUser.displayName,
        email: `${fixtureUser.username}@example.com`,
        emailVerified: true,
        image: fixtureUser.avatarUrl,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: user.id });
    await insertOrSkip(counter, rows);
  }

  const docRows = await database
    .insert(megaDocs)
    .values({
      id: SAMPLE_DOC.id,
      title: SAMPLE_DOC.title,
      excerpt: SAMPLE_DOC.excerpt,
      authorId: SAMPLE_DOC.author.id,
      status: SAMPLE_DOC.status ?? megaDocStatus.DRAFT,
      viewCount: SAMPLE_DOC.viewCount,
      createdAt: new Date(SAMPLE_DOC.createdAt),
      updatedAt: new Date(SAMPLE_DOC.updatedAt),
    })
    .onConflictDoNothing()
    .returning({ id: megaDocs.id });
  await insertOrSkip(counter, docRows);

  const version = SAMPLE_DOC.versions[0];
  if (version) {
    const versionRows = await database
      .insert(megaDocVersions)
      .values({
        id: version.id,
        docId: SAMPLE_DOC.id,
        version: version.version,
        authorId: version.author.id,
        summary: version.summary,
        createdAt: new Date(version.createdAt),
      })
      .onConflictDoNothing()
      .returning({ id: megaDocVersions.id });
    await insertOrSkip(counter, versionRows);
  }

  const collaboratorRows = await database
    .insert(megaDocCollaborators)
    .values({
      id: `collab_${SAMPLE_DOC.id}_${USERS.eleanor.id}`,
      docId: SAMPLE_DOC.id,
      userId: USERS.eleanor.id,
      role: megaDocCollaboratorRoles.EDITOR,
    })
    .onConflictDoNothing()
    .returning({ id: megaDocCollaborators.id });
  await insertOrSkip(counter, collaboratorRows);

  if (SAMPLE_DOC.starred) {
    const starRows = await database
      .insert(megaDocStars)
      .values({
        id: `star_${SAMPLE_DOC.id}_${SAMPLE_DOC.author.id}`,
        docId: SAMPLE_DOC.id,
        userId: SAMPLE_DOC.author.id,
        createdAt: new Date(SAMPLE_DOC.createdAt),
      })
      .onConflictDoNothing()
      .returning({ id: megaDocStars.id });
    await insertOrSkip(counter, starRows);
  }

  const seededCL = await database.transaction(async (tx) => {
    await lockCLNumberAllocation(tx);
    const [existing] = await tx.select({ number: megaCls.number }).from(megaCls)
      .where(eq(megaCls.id, SAMPLE_CL.id)).limit(1);
    if (existing) {
      return { inserted: false, publicId: await ensureCLPublicId(tx, existing.number) };
    }
    const number = await nextCLNumber(tx);
    await tx
      .insert(megaCls)
      .values({
        id: SAMPLE_CL.id,
        number,
        title: SAMPLE_CL.title,
        state: SAMPLE_CL.state ?? megaClStates.WIP,
        packageId: SAMPLE_CL.packageId,
        authorId: SAMPLE_CL.author.id,
        reviewers: SAMPLE_CL.reviewers.map((reviewer) => ({
          userId: reviewer.user.id,
          verdict: reviewer.verdict,
          reviewedAt: reviewer.reviewedAt,
        })),
        additions: SAMPLE_CL.additions,
        deletions: SAMPLE_CL.deletions,
        files: [],
        revisions: [],
        ci: SAMPLE_CL.ci ?? megaClCiStatuses.QUEUED,
        merge: SAMPLE_CL.merge ?? megaClMergeStates.NEEDS_REVIEW,
        atomic: SAMPLE_CL.atomic,
        crossPackage: [...SAMPLE_CL.crossPackage],
        linkedIssues: [...SAMPLE_CL.linkedIssues],
        branch: SAMPLE_CL.branch,
        subscribed: SAMPLE_CL.subscribed ?? false,
        createdAt: new Date(SAMPLE_CL.createdAt),
        updatedAt: new Date(SAMPLE_CL.updatedAt),
      });
    await tx.insert(megaClPublicIds).values({ number, publicId: SAMPLE_CL.publicId }).onConflictDoNothing();
    return { inserted: true, publicId: await ensureCLPublicId(tx, number) };
  });
  if (seededCL.inserted) counter.noteInserted();
  else counter.noteSkipped(1);

  const channelRows = await database
    .insert(megaChannels)
    .values({
      id: SAMPLE_CHANNEL.id,
      kind: megaChannelKinds.PUBLIC,
      name: SAMPLE_CHANNEL.name,
      topic: SAMPLE_CHANNEL.topic,
      participantIds: ALL_USERS.map((member) => member.id),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: megaChannels.id });
  await insertOrSkip(counter, channelRows);

  for (const member of ALL_USERS) {
    const memberRows = await database
      .insert(megaChannelMembers)
      .values({
        id: `chnmem_${SAMPLE_CHANNEL.id}_${member.id}`,
        channelId: SAMPLE_CHANNEL.id,
        userId: member.id,
        role:
          member.id === USERS.tianjing.id
            ? megaChannelMemberRoles.ADMIN
            : megaChannelMemberRoles.MEMBER,
        joinedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: megaChannelMembers.id });
    await insertOrSkip(counter, memberRows);
  }

  for (const message of SAMPLE_MESSAGES) {
    const messageRows = await database
      .insert(megaMessages)
      .values({
        id: message.id,
        channelId: SAMPLE_CHANNEL.id,
        authorId: message.author.id,
        reactions: message.reactions.map((reaction) => ({
          emoji: reaction.emoji,
          count: reaction.count,
          reactedByMe: reaction.reactedByMe,
        })),
        createdAt: new Date(message.createdAt),
        updatedAt: new Date(message.createdAt),
      })
      .onConflictDoNothing()
      .returning({ id: megaMessages.id });
    await insertOrSkip(counter, messageRows);
  }

  const emptyDocBody = parseJsonBody(createEmptyMegaDocumentEditorStateJSON());
  const contentRows = [
    {
      containerType: megaContentContainerTypes.DOC,
      containerId: SAMPLE_DOC.id,
      bodyJson: emptyDocBody,
      bodyFormatVersion: 2,
    },
    {
      containerType: megaContentContainerTypes.CL,
      containerId: SAMPLE_CL.id,
      bodyJson: emptyDocBody,
      bodyFormatVersion: 2,
    },
    ...SAMPLE_MESSAGES.map((message) => ({
      containerType: megaContentContainerTypes.CHAT_MESSAGE,
      containerId: message.id,
      bodyJson: {
        segments: message.segments.map((segment) => segment.type === "cl-ref"
          ? { type: "cl-ref", publicId: seededCL.publicId } : segment),
      },
      bodyFormatVersion: 1,
    })),
  ];

  for (const row of contentRows) {
    const inserted = await database
      .insert(megaContent)
      .values(row)
      .onConflictDoNothing()
      .returning({ containerId: megaContent.containerId });
    await insertOrSkip(counter, inserted);
  }

  return { inserted: counter.inserted, skipped: counter.skipped };
}

function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../database/drizzle");
}

export async function seedMegaFromConnectionString(
  connectionString: string,
): Promise<SeedMegaResult> {
  if (!connectionString) {
    throw new Error(
      "[@megaui/engine] seed requires a non-empty connectionString (GC-07).",
    );
  }
  const client = createDatabaseClient({ connectionString });
  try {
    await migrate(client.db, { migrationsFolder: migrationsFolder() });
    return await seedMegaDatabase(client.db);
  } finally {
    await client.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) {
    throw new Error(
      "[@megaui/engine] DATABASE_URL is not set. Fail-closed: the seed CLI never falls back to a hardcoded connection string (GC-07).",
    );
  }
  const result = await seedMegaFromConnectionString(connectionString);
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "seed failed";
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  });
}
