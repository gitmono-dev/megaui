// FS-57：迁移一致性由本 run 的隔离器证明。
//
// The suite no longer runs against the environment's DATABASE_URL: the
// isolator creates a container of its own, derives the connection string
// from it, applies the migration set to a one-shot database and drops only
// what it created. The table check uses the explicit schema manifest, and
// the journal check reads the generated journal, so a new migration never
// needs a hand-written snapshot of either.
//
// The suite needs a docker daemon. Without one it is skipped locally with a
// warning, and in CI it is a hard failure.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  missingTables,
  readJournalTags,
  readPublicTables,
  resolveMigrationsFolder,
  type IsolatedPostgres,
} from "./test-support/isolated-pg";

/**
 * The explicit schema manifest (ADR-FS-01).
 *
 * Every schema card updates this list in its own change, so a migration that
 * stops creating a table is detected instead of being hidden behind a count.
 */
const EXPECTED_PUBLIC_TABLES = [
  "account",
  "enterprise_actor_inventory",
  "enterprise_actor_reservations",
  "enterprise_admin_operations",
  "enterprise_batch_checkpoints",
  "enterprise_challenges",
  "enterprise_directory_identity_watermarks",
  "enterprise_directory_snapshots",
  "enterprise_directory_watermarks",
  "enterprise_dm_deliveries",
  "enterprise_event_inbox",
  "enterprise_identity",
  "enterprise_jobs",
  "enterprise_login_budgets",
  "enterprise_login_grants",
  "enterprise_notification_outbox",
  "enterprise_pairings",
  "enterprise_policy",
  "enterprise_profile",
  "enterprise_quarantine",
  "enterprise_revocations",
  "mega_agent_threads",
  "mega_channel_members",
  "mega_channels",
  "mega_cl_comments",
  "mega_cls",
  "mega_content",
  "mega_content_blocks",
  "mega_content_links",
  "mega_doc_collaborators",
  "mega_doc_comments",
  "mega_doc_stars",
  "mega_doc_versions",
  "mega_docs",
  "mega_inline_comments",
  "mega_issue_comments",
  "mega_issues",
  "mega_messages",
  "mega_notifications",
  "mega_releases",
  "session",
  "user",
  "verification",
] as const;

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable && process.env.CI === "true") {
  throw new Error(
    "[@megaui/database] migrate.test.ts: a docker daemon is required in CI (the fixture owns its own Postgres).",
  );
}

if (!dockerAvailable) {
  console.warn(
    "[@megaui/database] migrate.test.ts: no docker daemon — skipping the migration consistency suite.",
  );
}

describe.skipIf(!dockerAvailable)(
  "migration consistency on an isolated Postgres of this run (FS-57)",
  () => {
    let isolated: IsolatedPostgres;
    let pool: Pool;

    beforeAll(async () => {
      isolated = await createIsolatedPostgres();
      await isolated.migrate();
      pool = new Pool({ connectionString: isolated.databaseUrl });
      pool.on("error", () => {});
    }, 120_000);

    afterAll(async () => {
      const errors: unknown[] = [];
      try { await pool?.end(); } catch (error) { errors.push(error); }
      try { await isolated?.destroy(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "migration fixture cleanup failed");
    }, 120_000);

    it("creates every table of the explicit manifest", async () => {
      const tables = await readPublicTables(pool);
      expect(missingTables(EXPECTED_PUBLIC_TABLES, tables)).toEqual([]);
      expect(tables).toEqual([...tables].sort());
    });

    it("preserves a legacy session row while exposing nullable enterprise metadata", async () => {
      await pool.query(
        `insert into "user" (id, name, email, email_verified)
         values ('fs32-legacy-user', 'FS32 Legacy', 'fs32-legacy@example.test', false)
         on conflict (id) do nothing`,
      );
      await pool.query(
        `insert into session (id, expires_at, token, user_id)
         values ('fs32-legacy-session', '2030-01-01T00:00:00Z', 'fs32-legacy-token', 'fs32-legacy-user')
         on conflict (id) do nothing`,
      );
      const before = (await pool.query(
        `select id, expires_at, token, user_id, enterprise_grant_id,
                enterprise_identity_id, auth_epoch, auth_method
           from session where id='fs32-legacy-session'`,
      )).rows;
      await isolated.migrate();
      const after = (await pool.query(
        `select id, expires_at, token, user_id, enterprise_grant_id,
                enterprise_identity_id, auth_epoch, auth_method
           from session where id='fs32-legacy-session'`,
      )).rows;
      expect(after).toEqual(before);
    });

    it("detects a table the manifest expects but the database lacks", async () => {
      const tables = await readPublicTables(pool);
      expect(missingTables(EXPECTED_PUBLIC_TABLES, tables)).toEqual([]);
      expect(missingTables([...EXPECTED_PUBLIC_TABLES, "mega_missing_table"], tables)).toEqual([
        "mega_missing_table",
      ]);
    });

    it("applies the generated journal and re-applying is a no-op", async () => {
      const journalTags = readJournalTags(resolveMigrationsFolder());
      expect(journalTags.length).toBeGreaterThan(0);

      const first = await pool.query(`select hash from drizzle.__drizzle_migrations order by id`);
      expect(first.rows).toHaveLength(journalTags.length);

      await isolated.migrate();

      const second = await pool.query(`select hash from drizzle.__drizzle_migrations order by id`);
      expect(second.rows).toEqual(first.rows);
    });

    it("creates the generated text_search column + GIN index on mega_content_blocks (EG-10, ADR-FS-01)", async () => {
      const columnRows = await pool.query<{
        column_name: string;
        data_type: string;
        is_generated: string;
        generation_expression: string;
      }>(
        `select column_name, data_type, is_generated, generation_expression
           from information_schema.columns
           where table_schema = 'public' and table_name = 'mega_content_blocks' and column_name = 'text_search'`,
      );
      expect(columnRows.rows).toHaveLength(1);
      const column = columnRows.rows[0];
      if (!column) throw new Error("unreachable: length asserted above");
      expect(column.data_type).toBe("tsvector");
      expect(column.is_generated).toBe("ALWAYS");
      expect(column.generation_expression).toContain("to_tsvector");
      expect(column.generation_expression).toContain("'english'");

      const indexRows = await pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
           where schemaname = 'public' and tablename = 'mega_content_blocks' and indexname = 'mega_content_blocks_fts_idx'`,
      );
      expect(indexRows.rows).toHaveLength(1);
      const index = indexRows.rows[0];
      if (!index) throw new Error("unreachable: length asserted above");
      expect(index.indexdef).toContain("USING gin");
      expect(index.indexdef).toContain("text_search");
    });

    it("keeps both the original and scoped pairing retention indexes (FS-91)", async () => {
      const indexes = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname,indexdef from pg_indexes where schemaname='public' and tablename='enterprise_pairings'
          and indexname in ('enterprise_pairings_retain_until_idx','enterprise_pairings_scope_retention_idx') order by indexname`,
      );
      expect(indexes.rows).toEqual([
        { indexname: "enterprise_pairings_retain_until_idx", indexdef: "CREATE INDEX enterprise_pairings_retain_until_idx ON public.enterprise_pairings USING btree (retain_until)" },
        { indexname: "enterprise_pairings_scope_retention_idx", indexdef: "CREATE INDEX enterprise_pairings_scope_retention_idx ON public.enterprise_pairings USING btree (scope, deployment_role, retain_until, id)" },
      ]);
    });

    it("has no down-migration files (GC-08/ADR-ARCH-02: forward-only)", async () => {
      const fs = await import("node:fs/promises");
      const entries = await fs.readdir(resolveMigrationsFolder());
      const sqlFiles = entries.filter((entry) => entry.endsWith(".sql"));
      expect(sqlFiles.length).toBeGreaterThan(0);
      for (const file of sqlFiles) {
        expect(file).not.toMatch(/down/i);
      }
    });
  },
);
