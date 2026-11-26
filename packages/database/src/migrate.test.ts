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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isBlockId } from "@megaui/core";
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
  "feishu_identities",
  "feishu_login_codes",
  "feishu_login_key_check",
  "feishu_login_sessions",
  "mega_agent_threads",
  "mega_channel_members",
  "mega_channels",
  "mega_cl_comments",
  "mega_cl_links",
  "mega_cl_public_ids",
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
  "mega_site_settings",
  "session",
  "user",
  "verification",
] as const;

/** The columns of `session` after FSL-168, sorted. */
const SESSION_COLUMNS = [
  "created_at",
  "expires_at",
  "id",
  "impersonated_by",
  "ip_address",
  "token",
  "updated_at",
  "user_agent",
  "user_id",
];

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

    it("creates no table outside the explicit manifest (FSL-168: the enterprise tables are dropped)", async () => {
      expect(await readPublicTables(pool)).toEqual([...EXPECTED_PUBLIC_TABLES]);
    });

    it("backfills one block-format public ID per distinct local or live CL number", async () => {
      const migration = await readFile(join(resolveMigrationsFolder(), "0024_mega_cl_public_ids.sql"), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("CREATE SCHEMA cl_upgrade");
        await client.query("SET LOCAL search_path = cl_upgrade");
        await client.query("CREATE TABLE mega_cls (number integer)");
        await client.query("CREATE TABLE mega_cl_links (number integer)");
        await client.query("INSERT INTO mega_cls VALUES (1), (2)");
        await client.query("INSERT INTO mega_cl_links VALUES (2), (3)");
        await client.query(migration);
        const { rows } = await client.query<{ number: number; public_id: string }>(
          "SELECT number, public_id FROM mega_cl_public_ids ORDER BY number",
        );
        expect(rows.map(row => row.number)).toEqual([1, 2, 3]);
        expect(rows.every(row => isBlockId(row.public_id))).toBe(true);
        expect(new Set(rows.map(row => row.public_id)).size).toBe(3);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("enforces unique, case-sensitive block-format CL codes and unique internal numbers", async () => {
      const insert = (number: number, code: string) =>
        pool.query("INSERT INTO mega_cl_public_ids (number, public_id) VALUES ($1, $2)", [number, code]);
      await insert(1, "Abcd012345_-");
      await insert(2, "abcd012345_-");
      await expect(insert(1, "Different123")).rejects.toMatchObject({ code: "23505" });
      await expect(insert(3, "Abcd012345_-")).rejects.toMatchObject({ code: "23505" });
      await expect(insert(3, "too.short")).rejects.toMatchObject({ code: "23514" });
      await expect(insert(3, "é12345678901")).rejects.toMatchObject({ code: "23514" });
    });

    it("preserves a legacy session row on re-migration; session has no enterprise columns (FSL-168)", async () => {
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
      const before = (await pool.query(`select * from session where id='fs32-legacy-session'`)).rows;
      expect(before).toHaveLength(1);
      await isolated.migrate();
      const after = (await pool.query(`select * from session where id='fs32-legacy-session'`)).rows;
      expect(after).toEqual(before);
      // The row carries exactly the better-auth and admin-plugin columns: the four enterprise
      // columns were dropped by FSL-168.
      expect(Object.keys(after[0] as object).sort()).toEqual(SESSION_COLUMNS);
      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'session' order by column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(SESSION_COLUMNS);
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

    it("creates the four Feishu login code indexes (FSL-163)", async () => {
      const indexes = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname,indexdef from pg_indexes where schemaname='public' and tablename='feishu_login_codes'
          and indexname <> 'feishu_login_codes_pkey' order by indexname`,
      );
      expect(indexes.rows).toEqual([
        { indexname: "feishu_login_codes_created_at_idx", indexdef: "CREATE INDEX feishu_login_codes_created_at_idx ON public.feishu_login_codes USING btree (created_at)" },
        { indexname: "feishu_login_codes_email_created_at_idx", indexdef: "CREATE INDEX feishu_login_codes_email_created_at_idx ON public.feishu_login_codes USING btree (email_hmac, created_at)" },
        { indexname: "feishu_login_codes_email_seq_uidx", indexdef: "CREATE UNIQUE INDEX feishu_login_codes_email_seq_uidx ON public.feishu_login_codes USING btree (email_hmac, email_seq)" },
        { indexname: "feishu_login_codes_flow_seq_uidx", indexdef: "CREATE UNIQUE INDEX feishu_login_codes_flow_seq_uidx ON public.feishu_login_codes USING btree (flow_hash, flow_seq)" },
      ]);
    });

    it("creates the Feishu identity binding constraints (FSL-120)", async () => {
      const constraints = await pool.query<{ conname: string; definition: string }>(
        `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'public.feishu_identities'::regclass order by conname`,
      );
      expect(constraints.rows).toEqual([
        { conname: "feishu_identities_app_open_id_hmac_unique", definition: "UNIQUE (app_id, open_id_hmac)" },
        { conname: "feishu_identities_open_id_hmac_check", definition: "CHECK ((open_id_hmac ~ '^[0-9a-f]{64}$'::text))" },
        { conname: "feishu_identities_user_app_unique", definition: "UNIQUE (user_id, app_id)" },
        { conname: "feishu_identities_user_id_user_id_fk", definition: "FOREIGN KEY (user_id) REFERENCES \"user\"(id) ON DELETE CASCADE" },
      ]);
    });

    it("creates the Feishu session source table constraints (FSL-147)", async () => {
      const constraints = await pool.query<{ conname: string; definition: string }>(
        `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'public.feishu_login_sessions'::regclass order by conname`,
      );
      expect(constraints.rows).toEqual([
        { conname: "feishu_login_sessions_pkey", definition: "PRIMARY KEY (session_id)" },
        { conname: "feishu_login_sessions_session_id_session_id_fk", definition: "FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE" },
      ]);
    });

    it("creates the Feishu login key fingerprint table constraints (FSL-159)", async () => {
      const constraints = await pool.query<{ conname: string; definition: string }>(
        `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'public.feishu_login_key_check'::regclass order by conname`,
      );
      expect(constraints.rows).toEqual([
        { conname: "feishu_login_key_check_key_check_check", definition: "CHECK ((key_check ~ '^[0-9a-f]{64}$'::text))" },
        { conname: "feishu_login_key_check_pkey", definition: "PRIMARY KEY (id)" },
        { conname: "feishu_login_key_check_single_row_check", definition: "CHECK ((id = 1))" },
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
