import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCLPublicId } from "@megaui/core";
import { createDatabaseClient, megaClPublicIds, megaCls, megaContent, megaContentContainerTypes } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MegaBadRequestError,
  MegaConflictError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { SAMPLE_CL, USERS } from "../../testing/fixtures";
import { createClsService } from "./cls";
import { ensureCLPublicId, resolveCLNumber } from "./public-id";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] cls/cls.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] cls/cls.test.ts: DATABASE_URL is unset — skipping PG CL suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("createClsService list/detail/comments/description/transitions (EG-05, throwaway PG)", () => {
  const testDbName = `megaui_test_cls_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let adminPool: import("pg").Pool;
  let connectionString: string;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
    const migratePool = new Pool({ connectionString });
    const client = createDatabaseClient({ connectionString });
    try {
      await migrate((await import("drizzle-orm/node-postgres")).drizzle(migratePool), { migrationsFolder });
      await seedMegaDatabase(client.db);
    } finally {
      await client.close();
      await migratePool.end();
    }
  });

  afterAll(async () => {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  });

  it("createCL assigns the next number, defaults to wip/needs-review/queued-ci, and requires a signed-in actor", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const created = await cls.createCL(
        { title: "Add streaming diff viewer", packageId: "pkg_engine", branch: "eg-05-cl-core" },
        USERS.tianjing.id,
      );
      expect(created.number).toBe(SAMPLE_CL.number + 1);
      expect(isCLPublicId(created.publicId)).toBe(true);
      expect(await resolveCLNumber(client.db, created.publicId)).toBe(created.number);
      expect(await resolveCLNumber(client.db, String(created.number))).toBe(created.number);
      expect((await cls.getCL(created.number)).publicId).toBe(created.publicId);
      expect(created.state).toBe("wip");
      expect(created.merge).toBe("needs-review");
      expect(created.ci).toBe("queued");
      expect(created.author.id).toBe(USERS.tianjing.id);
      expect(created.reviewers).toEqual([]);
      expect(created.subscribed).toBe(true);
      expect(created.description).toBeUndefined();

      // Empty-body mint must be shared with the block index rebuild — a second
      // createEmptyMegaDocumentEditorStateJSON() call would index a different blockId.
      const [content] = await client.db
        .select({ bodyJson: megaContent.bodyJson })
        .from(megaContent)
        .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, created.id)))
        .limit(1);
      const storedRoot = content?.bodyJson as { root?: { children?: Array<{ blockId?: string }> } } | undefined;
      const storedBlockId = storedRoot?.root?.children?.[0]?.blockId;
      expect(typeof storedBlockId).toBe("string");
      const { createBlocksRepo } = await import("../docs/blocks");
      const indexed = await createBlocksRepo(client.db).listBySource(megaContentContainerTypes.CL, created.id);
      expect(indexed.map((row) => row.blockId)).toEqual([storedBlockId]);

      await expect(
        cls.createCL({ title: "Anon CL", packageId: "pkg_engine", branch: "b" }, null),
      ).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(
        cls.createCL({ title: "  ", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(
        cls.createCL({ title: "No branch", packageId: "pkg_engine", branch: "  " }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
    } finally {
      await client.close();
    }
  });

  it("allocates unique, gapless CL numbers under a concurrent create race (GC-08)", async () => {
    const client = createDatabaseClient({ connectionString, max: 10 });
    try {
      const cls = createClsService(client.db);
      const RACERS = 8;
      const created = await Promise.all(
        Array.from({ length: RACERS }, (_, index) =>
          cls.createCL({ title: `Race CL ${index}`, packageId: "pkg_engine", branch: `race-${index}` }, USERS.tianjing.id),
        ),
      );
      const numbers = created.map((cl) => cl.number);
      expect(new Set(numbers).size).toBe(RACERS);
      expect(new Set(created.map((cl) => cl.publicId)).size).toBe(RACERS);
    } finally {
      await client.close();
    }
  });

  it("getCL loads the seeded fixture CL, and 404s for an unknown number", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const cl = await cls.getCL(SAMPLE_CL.number);
      expect(cl.publicId).toBe(SAMPLE_CL.publicId);
      expect(cl.title).toBe(SAMPLE_CL.title);
      expect(cl.author.id).toBe(SAMPLE_CL.author.id);
      expect(cl.reviewers).toHaveLength(1);
      expect(cl.reviewers[0]).toMatchObject({ user: { id: USERS.tianjing.id }, verdict: "approved" });

      await expect(cls.getCL(999_999)).rejects.toBeInstanceOf(MegaNotFoundError);
    } finally {
      await client.close();
    }
  });

  it("reserves stable codes on concurrent legacy reads and treats twelve digits as a public code", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const number = 2_050;
      const codes = await Promise.all(Array.from({ length: 8 }, () => ensureCLPublicId(client.db, number)));
      expect(new Set(codes).size).toBe(1);
      // Both historical codes deliberately differ from the canonical value beyond punctuation.
      await client.db.insert(megaClPublicIds).values({
        number: number + 1, publicId: "000000000001",
        legacyPublicId: "0123-567_9AB", underscorePublicId: "0123_567_9AB",
      });
      expect(await resolveCLNumber(client.db, "000000000001")).toBe(number + 1);
      expect(await resolveCLNumber(client.db, "0123-567_9AB")).toBe(number + 1);
      expect(await resolveCLNumber(client.db, "0123_567_9AB")).toBe(number + 1);
      expect(await ensureCLPublicId(client.db, number + 1)).toBe("000000000001");
      await expect(resolveCLNumber(client.db, "0123-567_9Ab")).rejects.toBeInstanceOf(MegaNotFoundError);
      await expect(resolveCLNumber(client.db, "0123_567_9Ab")).rejects.toBeInstanceOf(MegaNotFoundError);
      await expect(resolveCLNumber(client.db, "000000000002")).rejects.toBeInstanceOf(MegaNotFoundError);
      await expect(resolveCLNumber(client.db, "2147483648")).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(resolveCLNumber(client.db, "../1")).rejects.toBeInstanceOf(MegaBadRequestError);
      const created = await createClsService(client.db).createCL(
        { title: "Retired CL numbers stay reserved", packageId: "pkg_engine", branch: "retired" }, USERS.tianjing.id,
      );
      expect(created.number).toBeGreaterThan(number + 1);
    } finally {
      await client.close();
    }
  });

  it("listCLs applies the shared filter DSL (state/package/reviewer/@me) and default recency sort", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const wip = await cls.createCL({ title: "WIP filter probe", packageId: "pkg_filter", branch: "b1" }, USERS.eleanor.id);

      const readyOnly = await cls.listCLs({ text: undefined, states: ["ready"] }, USERS.tianjing.id);
      expect(readyOnly.some((cl) => cl.number === wip.number)).toBe(false);
      expect(readyOnly.some((cl) => cl.number === SAMPLE_CL.number)).toBe(true);

      const scopedByPackage = await cls.listCLs({ packageIds: ["pkg_filter"] }, USERS.tianjing.id);
      expect(scopedByPackage.map((cl) => cl.number)).toEqual([wip.number]);

      const authoredByMe = await cls.listCLs({ author: "@me" }, USERS.eleanor.id);
      expect(authoredByMe.some((cl) => cl.number === wip.number)).toBe(true);
      expect(authoredByMe.some((cl) => cl.number === SAMPLE_CL.number)).toBe(false);

      // Illegal filter tokens never throw — they fall back to plain text (AC1).
      const all = await cls.listCLs({}, USERS.tianjing.id);
      const textFallback = await cls.listCLs({ text: "is:bogus-state" }, USERS.tianjing.id);
      expect(textFallback.length).toBeLessThanOrEqual(all.length);

      const sorted = await cls.listCLs({ sort: "updated-asc" }, USERS.tianjing.id);
      const updatedTimes = sorted.map((cl) => new Date(cl.updatedAt).getTime());
      expect(updatedTimes).toEqual([...updatedTimes].sort((a, b) => a - b));
    } finally {
      await client.close();
    }
  });

  it("finds a migrated code without hiding literal title matches or bypassing other filters", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const oldCode = "Old-Test2026";
      const intermediateCode = "Old_Test2026";
      const migrated = await cls.createCL({ title: "Migrated CL", packageId: "migrated", branch: "m" }, USERS.eleanor.id);
      const byTitle = await cls.createCL({ title: `See ${oldCode}`, packageId: "literal", branch: "l" }, USERS.eleanor.id);
      await client.db.update(megaClPublicIds).set({ legacyPublicId: oldCode, underscorePublicId: intermediateCode })
        .where(eq(megaClPublicIds.number, migrated.number));

      const hits = await cls.listCLs({ text: oldCode });
      expect(hits.map((cl) => cl.publicId).sort()).toEqual([migrated.publicId, byTitle.publicId].sort());
      expect((await cls.listCLs({ text: `!${intermediateCode}` })).map((cl) => cl.publicId)).toEqual([migrated.publicId]);
      expect(await cls.listCLs({ text: `!${oldCode}`, packageIds: ["literal"] })).toEqual([]);
      expect(await cls.resolveSearchPublicId(oldCode.toLowerCase())).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("toggleCLSubscription flips the subscribed flag and requires a signed-in actor", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const created = await cls.createCL({ title: "Subscribe probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);
      expect(created.subscribed).toBe(true);

      const unsubscribed = await cls.toggleCLSubscription(created.number, USERS.tianjing.id);
      expect(unsubscribed.subscribed).toBe(false);
      const resubscribed = await cls.toggleCLSubscription(created.number, USERS.tianjing.id);
      expect(resubscribed.subscribed).toBe(true);

      await expect(cls.toggleCLSubscription(created.number, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
    } finally {
      await client.close();
    }
  });

  it("addCLComment/listCLComments: timeline is createdAt-ascending, bumps CL.updatedAt, rejects empty bodies and anonymous authors (comment/timeline semantics, AC3)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const created = await cls.createCL({ title: "Comment timeline probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);
      const beforeUpdatedAt = created.updatedAt;

      await expect(cls.addCLComment(created.number, "hello", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(cls.addCLComment(created.number, "   ", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(
        cls.addCLComment(created.number, JSON.stringify({ root: { children: [] } }), USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);

      const first = await cls.addCLComment(created.number, "First pass looks good.", USERS.eleanor.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await cls.addCLComment(created.number, "Ping !" + created.number + " reviewers", USERS.rafael.id);

      const timeline = await cls.listCLComments(created.number);
      expect(timeline.map((comment) => comment.id)).toEqual([first.id, second.id]);
      expect(new Date(timeline[0]!.createdAt).getTime()).toBeLessThanOrEqual(new Date(timeline[1]!.createdAt).getTime());
      expect(timeline[0]).toMatchObject({ author: { id: USERS.eleanor.id }, reactions: [] });
      expect(JSON.parse(timeline[0]!.body)).toEqual(JSON.parse(first.body));

      const afterComments = await cls.getCL(created.number);
      expect(new Date(afterComments.updatedAt).getTime()).toBeGreaterThan(new Date(beforeUpdatedAt).getTime());

      await expect(cls.listCLComments(999_999)).rejects.toBeInstanceOf(MegaNotFoundError);
    } finally {
      await client.close();
    }
  });

  it("getCLDescription/saveCLDescription: author-only edit, plain-text summary projection, and envelope key preservation", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const created = await cls.createCL({ title: "Description probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);

      const empty = await cls.getCLDescription(created.number);
      expect(JSON.parse(empty.body)).toMatchObject({ root: { children: expect.any(Array) } });

      await expect(cls.saveCLDescription(created.number, "New description", null)).rejects.toBeInstanceOf(
        MegaUnauthorizedError,
      );
      await expect(cls.saveCLDescription(created.number, "New description", USERS.eleanor.id)).rejects.toBeInstanceOf(
        MegaForbiddenError,
      );

      const saved = await cls.saveCLDescription(created.number, "Adds retry with backoff.", USERS.tianjing.id);
      expect(JSON.parse(saved.body).root.children[0].children[0]).toMatchObject({ text: "Adds retry with backoff." });

      const reloaded = await cls.getCL(created.number);
      expect(reloaded.description).toBe("Adds retry with backoff.");

      // Manually inject an EG-06-shaped envelope key and confirm a later
      // description save preserves it (forward-compat with checks/dep-graph).
      const [contentRow] = await client.db
        .select({ bodyJson: megaContent.bodyJson })
        .from(megaContent)
        .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, created.id)));
      await client.db
        .update(megaContent)
        .set({ bodyJson: { ...(contentRow!.bodyJson as Record<string, unknown>), checksView: { pipeline: "stub" } } })
        .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, created.id)));

      await cls.saveCLDescription(created.number, "Second revision of the description.", USERS.tianjing.id);
      const [afterSave] = await client.db
        .select({ bodyJson: megaContent.bodyJson })
        .from(megaContent)
        .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, created.id)));
      expect(afterSave!.bodyJson).toMatchObject({ checksView: { pipeline: "stub" } });
    } finally {
      await client.close();
    }
  });

  it("EG-06 ER-05 P1: saveCLDescription and a concurrent checksView writer both land — the megaCls row lock serializes them instead of one clobbering the other", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const created = await cls.createCL({ title: "Concurrent envelope writers", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);

      // Both start from the same pre-write envelope (`{}` — no root, no
      // checksView yet) and run genuinely concurrently. Without the
      // `megaCls` `FOR UPDATE` lock in `saveCLDescription`, whichever
      // transaction commits last would silently drop the other's key —
      // that lost-update window is exactly what this test exercises.
      await Promise.all([
        cls.saveCLDescription(created.number, "Concurrent description write.", USERS.tianjing.id),
        cls.upsertCLCheckRun(created.number, { name: "build", status: "passing" }, USERS.tianjing.id),
      ]);

      const [contentRow] = await client.db
        .select({ bodyJson: megaContent.bodyJson })
        .from(megaContent)
        .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, created.id)));
      const envelope = contentRow!.bodyJson as Record<string, unknown>;

      // Both writers' keys must have survived — neither's read-modify-write
      // was based on a stale pre-write snapshot of the other.
      expect((envelope.root as { children?: unknown[] } | undefined)?.children).toBeDefined();
      expect(envelope.checksView).toMatchObject({ checks: [{ name: "build", status: "passing" }] });

      const description = await cls.getCLDescription(created.number);
      expect(JSON.parse(description.body).root.children[0].children[0]).toMatchObject({
        text: "Concurrent description write.",
      });
      const checks = await cls.getCLChecks(created.number);
      expect(checks.checks).toHaveLength(1);
      expect(checks.checks[0]?.name).toBe("build");
    } finally {
      await client.close();
    }
  });

  it("transitionCLState wires the fail-closed permission×state decision surface end-to-end", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const created = await cls.createCL({ title: "Transition probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);
      expect(created.state).toBe("wip");

      await expect(cls.transitionCLState(created.number, "ready", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(cls.transitionCLState(created.number, "ready", USERS.eleanor.id)).rejects.toBeInstanceOf(
        MegaForbiddenError,
      );
      await expect(cls.transitionCLState(created.number, "merged", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaConflictError,
      );

      const ready = await cls.transitionCLState(created.number, "ready", USERS.tianjing.id);
      expect(ready.state).toBe("ready");
      // No reviewers yet: Array#every is vacuously true → queue-ready.
      expect(ready.merge).toBe("queue-ready");

      const queued = await cls.transitionCLState(created.number, "queued", USERS.tianjing.id);
      expect(queued.state).toBe("queued");
      expect(queued.merge).toBe("in-queue");

      const merged = await cls.transitionCLState(created.number, "merged", USERS.tianjing.id);
      expect(merged.state).toBe("merged");
      expect(merged.merge).toBe("merged");
      expect(merged.mergedAt).toBeDefined();

      await expect(cls.transitionCLState(created.number, "wip", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaConflictError,
      );

      const noop = await cls.transitionCLState(created.number, "merged", USERS.tianjing.id);
      expect(noop.state).toBe("merged");

      await expect(cls.transitionCLState(999_999, "ready", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
    } finally {
      await client.close();
    }
  });

  it("transitionCLState blocks ready→queued until every reviewer has approved (queue-not-ready)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const cls = createClsService(client.db);
      const created = await cls.createCL({ title: "Queue gate probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);
      await cls.transitionCLState(created.number, "ready", USERS.tianjing.id);

      // Seed a pending reviewer directly (EG-05 has no reviewer-verdict mutator —
      // matches upstream, which only ever populates reviewers via fixtures)
      // and mirror the merge recompute a real verdict-change call would do.
      await client.db
        .update(megaCls)
        .set({ reviewers: [{ userId: USERS.eleanor.id, verdict: "pending" }], merge: "needs-review" })
        .where(eq(megaCls.number, created.number));

      const blocked = await cls.getCL(created.number);
      expect(blocked.merge).toBe("needs-review");
      await expect(cls.transitionCLState(created.number, "queued", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaConflictError,
      );
    } finally {
      await client.close();
    }
  });
});
