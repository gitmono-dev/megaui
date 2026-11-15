import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MegaBadRequestError,
  MegaConflictError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { buildReleaseAssetKey } from "./asset-key";
import { createReleasesService } from "./index";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] releases/releases.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] releases/releases.test.ts: DATABASE_URL is unset — skipping PG releases suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Guarantees a distinct millisecond `publishedAt` between sequential publishes. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!adminDatabaseUrl)("createReleasesService list/publish/assets (EG-08, throwaway PG)", () => {
  const testDbName = `megaui_test_releases_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  it("creates a draft release with notes, seeds sinceTag from the latest published release, and round-trips through getRelease", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const releases = createReleasesService(client.db);

      const older = await releases.createDraftRelease(
        { tag: "v0.4.1-rt", title: "older", targetSha: "1111111" },
        USERS.tianjing.id,
      );
      await releases.publishRelease(older.id, USERS.tianjing.id);

      const draft = await releases.createDraftRelease(
        { tag: "v0.4.2-rt", title: "git-internal 0.4.2", targetSha: "2222222", notes: ["first note", "  ", "second note"] },
        USERS.eleanor.id,
      );

      expect(draft.state).toBe("draft");
      expect(draft.publishedAt).toBeUndefined();
      expect(draft.sinceTag).toBe("v0.4.1-rt");
      expect(draft.commitsSince).toBe(0);
      expect(draft.author.id).toBe(USERS.eleanor.id);
      expect(draft.assets).toEqual([]);
      expect(draft.notes.map((note) => note.text)).toEqual(["first note", "second note"]);
      expect(draft.notes.every((note) => note.kind === "feature")).toBe(true);
      expect(draft.notes.every((note) => note.linkedCLs.length === 0)).toBe(true);

      const fetched = await releases.getRelease(draft.id);
      expect(fetched).toEqual(draft);
    } finally {
      await client.close();
    }
  });

  it("rejects duplicate tags with MegaConflictError, and rejects blank/missing required fields", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const releases = createReleasesService(client.db);
      await releases.createDraftRelease({ tag: "v0.5.0-dup", title: "first", targetSha: "abcdef0" }, USERS.tianjing.id);
      await expect(
        releases.createDraftRelease({ tag: "v0.5.0-dup", title: "dup", targetSha: "abcdef1" }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaConflictError);
      await expect(
        releases.createDraftRelease({ tag: "v0.5.0-dup", title: "dup", targetSha: "abcdef1" }, USERS.tianjing.id),
      ).rejects.toThrow(/already exists/);

      await expect(
        releases.createDraftRelease({ tag: "  ", title: "t", targetSha: "sha" }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(
        releases.createDraftRelease({ tag: "v0.5.1", title: "  ", targetSha: "sha" }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(
        releases.createDraftRelease({ tag: "v0.5.2", title: "t", targetSha: "  " }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
    } finally {
      await client.close();
    }
  });

  it("rejects createDraftRelease for an unauthenticated actor and a non-member actor", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const releases = createReleasesService(client.db);
      await expect(
        releases.createDraftRelease({ tag: "v0.6.0", title: "t", targetSha: "sha" }, null),
      ).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(
        releases.createDraftRelease({ tag: "v0.6.0", title: "t", targetSha: "sha" }, "usr_does_not_exist"),
      ).rejects.toBeInstanceOf(MegaForbiddenError);
    } finally {
      await client.close();
    }
  });

  describe("AC1: draft→publish state machine (reject duplicate publish)", () => {
    it("publishes a draft exactly once; a second publish is rejected as a conflict", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const draft = await releases.createDraftRelease(
          { tag: "v0.7.0-pub", title: "publishable", targetSha: "cafe001" },
          USERS.tianjing.id,
        );
        expect(draft.state).toBe("draft");

        const published = await releases.publishRelease(draft.id, USERS.tianjing.id);
        expect(published.state).toBe("published");
        expect(published.publishedAt).toBeDefined();

        await expect(releases.publishRelease(draft.id, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaConflictError);
        await expect(releases.publishRelease(draft.id, USERS.tianjing.id)).rejects.toThrow(/already published/);

        // A rejected duplicate publish must not mutate the already-published state.
        const unchanged = await releases.getRelease(draft.id);
        expect(unchanged.state).toBe("published");
        expect(unchanged.publishedAt).toBe(published.publishedAt);
      } finally {
        await client.close();
      }
    });

    it("rejects publish for an unauthenticated actor, a non-member actor, and a missing release", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const draft = await releases.createDraftRelease(
          { tag: "v0.7.1-pub", title: "auth matrix", targetSha: "cafe002" },
          USERS.tianjing.id,
        );

        await expect(releases.publishRelease(draft.id, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(releases.publishRelease(draft.id, "usr_does_not_exist")).rejects.toBeInstanceOf(
          MegaForbiddenError,
        );
        await expect(releases.publishRelease("release_missing", USERS.tianjing.id)).rejects.toBeInstanceOf(
          MegaNotFoundError,
        );
      } finally {
        await client.close();
      }
    });
  });

  describe("AC2: asset key ownership (GC-07)", () => {
    it("attaches an asset whose key is scoped under the release's own prefix", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const draft = await releases.createDraftRelease(
          { tag: "v0.8.0-asset", title: "asset owner", targetSha: "beef001" },
          USERS.tianjing.id,
        );

        const key = buildReleaseAssetKey({ releaseId: draft.id, fileName: "app-linux.tar.gz" });
        const updated = await releases.addReleaseAsset(
          draft.id,
          { name: "app-linux.tar.gz", key, sizeBytes: 4_200_000, contentType: "application/gzip" },
          USERS.tianjing.id,
        );

        expect(updated.assets).toHaveLength(1);
        expect(updated.assets[0]).toMatchObject({
          name: "app-linux.tar.gz",
          key,
          sizeBytes: 4_200_000,
          contentType: "application/gzip",
        });

        const second = await releases.addReleaseAsset(
          draft.id,
          {
            name: "app-darwin.tar.gz",
            key: buildReleaseAssetKey({ releaseId: draft.id, fileName: "app-darwin.tar.gz" }),
            sizeBytes: 3_900_000,
            contentType: "application/gzip",
          },
          USERS.eleanor.id,
        );
        expect(second.assets.map((asset) => asset.name)).toEqual(["app-linux.tar.gz", "app-darwin.tar.gz"]);
      } finally {
        await client.close();
      }
    });

    it("rejects an asset key scoped to a different release (cross-release key hijack)", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const draftA = await releases.createDraftRelease(
          { tag: "v0.8.1-asset-a", title: "a", targetSha: "beef002" },
          USERS.tianjing.id,
        );
        const draftB = await releases.createDraftRelease(
          { tag: "v0.8.2-asset-b", title: "b", targetSha: "beef003" },
          USERS.tianjing.id,
        );

        const keyForB = buildReleaseAssetKey({ releaseId: draftB.id, fileName: "payload.zip" });
        await expect(
          releases.addReleaseAsset(
            draftA.id,
            { name: "payload.zip", key: keyForB, sizeBytes: 10, contentType: "application/zip" },
            USERS.tianjing.id,
          ),
        ).rejects.toBeInstanceOf(MegaForbiddenError);

        // The rejected attach must not have mutated release A's assets.
        expect((await releases.getRelease(draftA.id)).assets).toEqual([]);
      } finally {
        await client.close();
      }
    });

    it("rejects a malformed asset key (path traversal / absolute path) and other bad input", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const draft = await releases.createDraftRelease(
          { tag: "v0.8.3-asset-bad", title: "bad input", targetSha: "beef004" },
          USERS.tianjing.id,
        );

        await expect(
          releases.addReleaseAsset(
            draft.id,
            { name: "x", key: `releases/${draft.id}/../escape.zip`, sizeBytes: 1, contentType: "application/zip" },
            USERS.tianjing.id,
          ),
        ).rejects.toBeInstanceOf(MegaBadRequestError);

        await expect(
          releases.addReleaseAsset(
            draft.id,
            { name: "  ", key: buildReleaseAssetKey({ releaseId: draft.id, fileName: "x.zip" }), sizeBytes: 1, contentType: "application/zip" },
            USERS.tianjing.id,
          ),
        ).rejects.toBeInstanceOf(MegaBadRequestError);

        await expect(
          releases.addReleaseAsset(
            draft.id,
            {
              name: "x.zip",
              key: buildReleaseAssetKey({ releaseId: draft.id, fileName: "x.zip" }),
              sizeBytes: -1,
              contentType: "application/zip",
            },
            USERS.tianjing.id,
          ),
        ).rejects.toBeInstanceOf(MegaBadRequestError);
      } finally {
        await client.close();
      }
    });

    it("rejects addReleaseAsset for an unauthenticated actor, a non-member actor, and a missing release", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const draft = await releases.createDraftRelease(
          { tag: "v0.8.4-asset-auth", title: "auth", targetSha: "beef005" },
          USERS.tianjing.id,
        );
        const key = buildReleaseAssetKey({ releaseId: draft.id, fileName: "x.zip" });

        await expect(
          releases.addReleaseAsset(draft.id, { name: "x", key, sizeBytes: 1, contentType: "application/zip" }, null),
        ).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(
          releases.addReleaseAsset(
            draft.id,
            { name: "x", key, sizeBytes: 1, contentType: "application/zip" },
            "usr_does_not_exist",
          ),
        ).rejects.toBeInstanceOf(MegaForbiddenError);
        await expect(
          releases.addReleaseAsset(
            "release_missing",
            { name: "x", key: buildReleaseAssetKey({ releaseId: "release_missing", fileName: "x.zip" }), sizeBytes: 1, contentType: "application/zip" },
            USERS.tianjing.id,
          ),
        ).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });
  });

  describe("AC3: list sort/pagination boundaries", () => {
    it("sorts drafts to the top, then published releases newest-first, with a stable id tie-break", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);

        const pubOld = await releases.createDraftRelease(
          { tag: "v1.0.0-sort", title: "old", targetSha: "s1" },
          USERS.tianjing.id,
        );
        await releases.publishRelease(pubOld.id, USERS.tianjing.id);
        await sleep(5);
        const pubNew = await releases.createDraftRelease(
          { tag: "v1.1.0-sort", title: "new", targetSha: "s2" },
          USERS.tianjing.id,
        );
        await releases.publishRelease(pubNew.id, USERS.tianjing.id);
        const draft1 = await releases.createDraftRelease(
          { tag: "v1.2.0-sort", title: "draft1", targetSha: "s3" },
          USERS.tianjing.id,
        );
        const draft2 = await releases.createDraftRelease(
          { tag: "v1.3.0-sort", title: "draft2", targetSha: "s4" },
          USERS.tianjing.id,
        );

        // The suite shares one throwaway DB across tests, so `listReleases`
        // also returns releases created by earlier tests — assert relative
        // ordering of this test's own releases rather than an exact slice.
        const result = await releases.listReleases({ pagination: { limit: 100 } });
        const ids = result.items.map((release) => release.id);
        const indexOf = (id: string) => ids.indexOf(id);
        const firstDraftId = draft1.id < draft2.id ? draft1.id : draft2.id;
        const secondDraftId = draft1.id < draft2.id ? draft2.id : draft1.id;

        // Drafts (no publishedAt) sort before every published release.
        expect(indexOf(draft1.id)).toBeLessThan(indexOf(pubNew.id));
        expect(indexOf(draft2.id)).toBeLessThan(indexOf(pubOld.id));
        // Among drafts, the stable id tie-break holds.
        expect(indexOf(firstDraftId)).toBeLessThan(indexOf(secondDraftId));
        // Published releases sort newest-first.
        expect(indexOf(pubNew.id)).toBeLessThan(indexOf(pubOld.id));
      } finally {
        await client.close();
      }
    });

    it("paginates with total reflecting the full set, and returns empty items (not an error) past the end", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const created = [];
        for (let index = 0; index < 5; index += 1) {
          created.push(
            await releases.createDraftRelease(
              { tag: `v2.${index}.0-page`, title: `page ${index}`, targetSha: `page${index}` },
              USERS.tianjing.id,
            ),
          );
        }

        const all = await releases.listReleases({ pagination: { limit: 100 } });
        const total = all.total;
        expect(total).toBeGreaterThanOrEqual(5);

        const page1 = await releases.listReleases({ pagination: { offset: 0, limit: 2 } });
        expect(page1.items).toHaveLength(2);
        expect(page1.offset).toBe(0);
        expect(page1.limit).toBe(2);
        expect(page1.total).toBe(total);

        const page2 = await releases.listReleases({ pagination: { offset: 2, limit: 2 } });
        expect(page2.items).toHaveLength(2);
        // Pages must be disjoint and stable across calls.
        const page1Ids = new Set(page1.items.map((release) => release.id));
        for (const release of page2.items) expect(page1Ids.has(release.id)).toBe(false);

        const outOfRange = await releases.listReleases({ pagination: { offset: 1_000_000, limit: 20 } });
        expect(outOfRange.items).toEqual([]);
        expect(outOfRange.total).toBe(total);
      } finally {
        await client.close();
      }
    });

    it("defaults to offset 0 / limit 20, and fails closed on invalid pagination input", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const result = await releases.listReleases();
        expect(result.offset).toBe(0);
        expect(result.limit).toBe(20);

        await expect(releases.listReleases({ pagination: { limit: -1 } })).rejects.toBeInstanceOf(
          MegaBadRequestError,
        );
        await expect(releases.listReleases({ pagination: { offset: -1 } })).rejects.toBeInstanceOf(
          MegaBadRequestError,
        );
      } finally {
        await client.close();
      }
    });

    it("a far out-of-range offset always yields empty items with a non-negative total (no error)", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const releases = createReleasesService(client.db);
        const result = await releases.listReleases({ pagination: { offset: 1_000_000, limit: 5 } });
        expect(result.items).toEqual([]);
        expect(result.total).toBeGreaterThanOrEqual(0);
      } finally {
        await client.close();
      }
    });
  });
});
