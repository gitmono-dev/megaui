# `@megaui/database`

PG-only [drizzle-orm](https://orm.drizzle.team/) infrastructure for megaui's
self-owned persistence (`ADR-ARCH-02`): a bounded connection pool with
release/timeout semantics, `drizzle-kit` config/scripts, the four
better-auth 1.x auth tables (`user`/`account`/`session`/`verification`),
and the 19 `mega_*` content tables (PK-05).

## Migrations have no down entry (GC-08 / ADR-ARCH-02)

**This package only ever ships forward (`up`) migrations.** There is no
`db:rollback`/`down` script, no down-SQL file, and no plan to add one.
`drizzle-kit migrate` applies whatever hasn't been applied yet, tracked in
the `drizzle.__drizzle_migrations` table — running it twice is a no-op the
second time (idempotent).

- **Recovery model:** `forward-only`. If a migration turns out to be wrong,
  the fix is a **new** migration that corrects the schema, never a `down`
  revert of the old one.
- **Data invariant:** the auth four-table schema always matches what the
  better-auth drizzle adapter expects (see "Schema" below) — a mismatch is
  a defect to fix forward, not something to roll back to "before."
- **User impact when a dev/CI database needs to be reset:** `drop database`
  + re-run `pnpm db:migrate` from scratch. There is no supported "undo the
  last migration" path.

This mirrors the plan's global decision (`ADR-ARCH-02`): "迁移仅提供 up
（`drizzle-kit migrate`），**无 down 入口**".

## Connection pool: release/timeout semantics (GC-09)

`createDatabaseClient()` wraps a single `pg.Pool` (ADR-ARCH-02: PG is the
only supported dialect — no sqlite/d1/Hyperdrive branching; upstream
multi-dialect / Workers paths from
`megaui:libs/database/index.ts@0ff3a9d` are intentionally dropped). It is
bounded and self-releasing:

| Option | Default | Semantics |
|---|---|---|
| `max` | `10` | Hard cap on simultaneously checked-out clients. |
| `idleTimeoutMillis` | `10_000` | Idle pooled clients are closed and evicted after this long. |
| `connectionTimeoutMillis` | `5_000` | `pool.connect()` **rejects** (instead of hanging forever) if no client frees up in time. |
| `statementTimeoutMillis` | `30_000` | Per-statement timeout (`pg` `statement_timeout`) so one stuck query can't hold a pooled client indefinitely. |

`DatabaseClient.close()` calls `pool.end()`: it waits for checked-out
clients to be released, then closes every connection. It's idempotent
(safe to call more than once — a second call resolves immediately) and is
what `apps/web` must call on graceful shutdown, and what tests call in
`afterEach`/`afterAll` to avoid leaking connections across test files.

`closeDatabaseClient()` keeps the process-wide singleton slot until
`pool.end()` resolves, and concurrent closes share one promise, so an
in-flight shutdown cannot be orphaned by a racing `getDatabaseClient()`
(GC-09).

A `pool.on('error', ...)` listener is always registered (defaults to
`console.error`, override via `onPoolError`) — without one, `pg` crashes
the process on an unhandled background client error (e.g. the backend
dropping an idle connection).

`packages/database/src/client.test.ts` asserts all of the above against a
live Postgres instance: release-on-`release()`, timeout-on-exhaustion,
idle-client eviction, and idempotent `close()`.

### Usage

```ts
import { getDb, getPool, closeDatabaseClient } from "@megaui/database";

const db = getDb(); // lazily creates the process-wide singleton from DATABASE_URL
await db.select().from(user).limit(1);

// graceful shutdown (e.g. a Next.js custom server's SIGTERM handler, or test teardown)
await closeDatabaseClient();
```

`getDb()`/`getPool()`/`getDatabaseClient()` are **lazy**: importing this
package never opens a socket or throws just because `DATABASE_URL` happens
to be unset in that process (e.g. during `typecheck`/`build` or unrelated
unit tests). The error is thrown at first *use*, not at import time
(fail-closed, GC-07 — no implicit fallback connection string).

For tests or any case needing an isolated pool instead of the shared
singleton, use the factory directly: `createDatabaseClient({ connectionString, ... })`.

## Schema

Four tables, matching [better-auth 1.x's documented core schema](https://www.better-auth.com/docs/concepts/database)
plus its `admin` plugin's fields (upstream keeps that plugin — see the
PK-06 task card, which does not list it as removed):

| Table | Fields |
|---|---|
| `user` | `id`, `name`, `email` (unique), `emailVerified`, `image`, `createdAt`, `updatedAt`, plus `admin` plugin fields `role`, `banned`, `banReason`, `banExpires` |
| `account` | `id`, `accountId`, `providerId`, `userId` (FK → `user.id`, cascade), `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `password`, `createdAt`, `updatedAt` |
| `session` | `id`, `expiresAt`, `token` (unique), `createdAt`, `updatedAt`, `ipAddress`, `userAgent`, `userId` (FK → `user.id`, cascade), plus `admin` plugin field `impersonatedBy` |
| `verification` | `id`, `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt` |

`packages/database/src/schema/auth/schema.test.ts` type-checks (via
`tsc --noEmit`) and runtime-asserts that these are **exactly** the field
sets above — no more, no less (PK-04 AC 2).

## Full-text search: `text_search` (EG-10 / `ADR-FS-01`)

`drizzle/0002_body_fts.sql` is a **hand-written** migration (not
`drizzle-kit generate`d) that adds a `GENERATED ALWAYS ... STORED` tsvector
column to `mega_content_blocks`:

```sql
ALTER TABLE mega_content_blocks
  ADD COLUMN text_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(text_summary, ''))) STORED;

CREATE INDEX mega_content_blocks_fts_idx ON mega_content_blocks USING gin (text_search);
```

Postgres maintains `text_search` automatically whenever `text_summary`
changes (`STORED` — no application-layer double-write). It is **not**
modeled in `src/schema/mega/mega-content.ts`'s `megaContentBlocks` Drizzle
table on purpose:

- `drizzle-kit generate` diffs the TS schema against the last snapshot, so
  a column that's never in the TS schema is never proposed for
  drop/re-add — that's *why* this migration had to be hand-written instead
  of generated, and why `db:push` is disabled (see above) instead of just
  discouraged.
- Every read of `text_search` goes through a raw `sql` template in
  `@megaui/engine`'s `services/search/english.ts` (`plainto_tsquery('english',
  ...)` + `ts_rank(...) DESC`, GIN-indexed, no `LIKE`/`ILIKE`).
- `drizzle/meta/0002_snapshot.json` (parent = `0001`'s snapshot) is
  otherwise identical to `0001_snapshot.json`'s `tables` — its only job is
  to keep `drizzle-kit`'s snapshot chain intact for *future* `db:generate`
  runs; it does not model `text_search` either, for the same reason.

This column is **English-only** (`to_tsvector('english', ...)`): CJK text
gets tokenized as a single opaque lexeme by the `english` config (no
zhparser/pg_jieba in `postgres:15-alpine`), so it cannot recall CJK
substrings through this index. CJK search is a separate, unmodeled
`position()`-based path (EG-14) — see `docs/implementation/adr-fs-01-pg-fts.md`
for the full spike writeup and go/no-go.

## Provenance (GC-03)

Ported files carry a GC-03 provenance header of the form
`megaui:libs/database/schema/pg/user.ts@0ff3a9d` (path + baseline SHA).
Baseline SHA `0ff3a9d` (plan `REF-07`).

| File | Source path (under REF-07) |
|---|---|
| `src/schema/auth/user.ts` | `libs/database/schema/pg/user.ts` |
| `src/schema/auth/auth.ts` | `libs/database/schema/pg/auth.ts` |
| `src/schema/mega/constants.ts` | `libs/database/constants.ts` (mega vocabulary only) |
| `src/schema/mega/mega-*.ts` | `libs/database/schema/pg/mega-*.ts` (7 files / 19 tables) |
| `src/client.ts` | `libs/database/index.ts` (connection/pool responsibility only) |
| `drizzle.config.ts` | `drizzle.config.ts` |
| `drizzle/0002_body_fts.sql` | `libs/database/drizzle/0011_body_fts.sql` (EG-10, `docs/implementation/adr-fs-01-pg-fts.md`) |

### Diffs vs upstream (intentional — registered on the PK-04 / PK-05 task cards)

| Upstream surface | Disposition here | Why |
|---|---|---|
| sqlite / D1 dialect branches, `getDialect()`/`isSqliteDialect()` | Removed entirely | ADR-ARCH-02: PG is the only dialect this repo supports. |
| Cloudflare Workers / Hyperdrive request-scoped client (`withRequestClient`, `setHyperdriveBinding`, `AsyncLocalStorage`-per-request `Client`) | Removed entirely | `apps/web` is a long-lived Node process, not a Workers isolate — a shared `pg.Pool` is sufficient and correct. |
| `user.phoneNumber` / `user.phoneNumberVerified` | Removed | The phone-number auth plugin is an explicit non-goal (PK-06: "不引入 phone/wechat 登录"). |
| `user.stripeCustomerId` / `creemCustomerId` / `dodoCustomerId` / `creditBalance` / `referralCode` / `referredByCode` / `commissionBalance` / `kycVerified` | Removed | SaaS billing/referral columns — out of scope per the plan's global "SaaS 模板域剥离" decision; this product has no billing/credits/affiliate feature at all. |
| `user.name` nullable, `user.email` with no DB-level unique constraint, `verification.createdAt`/`updatedAt` nullable with no default | Corrected to better-auth's documented schema (`name` NOT NULL, `email` UNIQUE NOT NULL, `verification` timestamps NOT NULL DEFAULT now()) | Upstream schema drifted from the better-auth docs on these points (reference debt, GC-13) — PK-04 AC 2 requires matching better-auth's *expected* fields, not upstream drift. |
| `user.banExpires` as `numeric` | Changed to `timestamp` | better-auth's `admin` plugin documents `banExpires` as a date/timestamp; upstream `numeric` is drift vs the docs, not an intentional choice. |
| `user.role` as `NOT NULL DEFAULT userRoles.USER` | Kept column; dropped `NOT NULL` + DB default | better-auth's admin plugin documents `role` as optional / app-defaulted; upstream DB-enforced default is drift vs the docs (GC-13), not an intentional product choice. |
| `account`/`session`/`verification` timestamps as bare `timestamp` (no tz); account/session created/updated without defaults; verification created/updated nullable | All auth timestamps → `timestamptz`; created/updated get `DEFAULT now()` (+ `$onUpdate` on updatedAt); verification timestamps NOT NULL | Align with upstream `user` timestamptz convention + better-auth docs (DEBT-10 for verification nullability). |
| SaaS tables `order` / `subscription` / `pricing_plan` / `credit_transaction` / `commission` / `withdrawal` / `blog_post` | Not ported | PK-05 / SaaS 剥离 — only the 19 `mega_*` content tables are in scope. |
| FTS generated column + GIN on `mega_content_blocks` (`0011_body_fts`) | Landed as `drizzle/0002_body_fts.sql` (English only) | PK-05 deferred it; EG-10 (`ADR-FS-01`) ported the English `tsvector`+GIN path. CJK substring recall is a separate, unmodeled `position()` path (EG-14) — not this column. |
| `check-connection.ts`, `seed.ts` | Out of scope | No seed script required for schema cards. |

`role`/`banned`/`banReason`/`banExpires` (user) and `impersonatedBy`
(session) are **kept** — they are the better-auth `admin` plugin's schema
fields, and PK-06 (the auth-service card that configures plugins) does not
list `admin` among the plugins it removes (it only removes
`phoneNumber`/`wechat`/`captcha`).

## Scripts

| Script | Command | Use |
|---|---|---|
| `db:generate` | `drizzle-kit generate` | Diff `src/schema/**` against the last migration snapshot and write a new `drizzle/NNNN_*.sql` file. Doesn't touch a live database. |
| `db:migrate` | `drizzle-kit migrate` | Apply every not-yet-applied migration in `drizzle/` to `DATABASE_URL`. Idempotent — safe to run repeatedly. |
| `db:push` | `node ./scripts/db-push-disabled.mjs` (**hard-disabled**) | See "`db:push` is disabled" below. |

`db:generate`/`db:migrate` require `DATABASE_URL` to be set (fail-closed —
`drizzle.config.ts` throws a clear error otherwise, per GC-07). `db:push`
needs nothing — it never touches a database; it always prints an error to
stderr and exits `1`.

### `db:push` is disabled (ADR-FS-01 Consequences #7 / EG-10)

`drizzle-kit push` diffs the **live database** against the Drizzle
**model** and pushes whatever's different — no migration file, no review.
That's fine as long as the model is the full truth about the schema, but
it no longer is: `mega_content_blocks.text_search` (the generated `tsvector`
column + `mega_content_blocks_fts_idx` GIN index added by
`drizzle/0002_body_fts.sql`) is **intentionally not modeled** in
`src/schema/mega/mega-content.ts` (see that file's comment). An unmodified
`db:push` would see `text_search`/its index as unmanaged drift and offer to
drop them — silently breaking English full-text search the next time
someone ran it.

Rather than rely on everyone remembering "don't run `db:push` on this
package," the script itself is replaced with `scripts/db-push-disabled.mjs`,
which unconditionally prints an explanation and exits non-zero. There is no
flag or env var that re-enables the real `drizzle-kit push` — the fix for
"I want push-style fast iteration" is a real migration via `db:generate` +
`db:migrate`.

## Testing this package locally

The migration-consistency and pool-lifecycle test suites need a reachable
Postgres server. If you don't already have one:

```bash
docker run --rm -d --name megaui-pg-test \
  -e POSTGRES_USER=megaui -e POSTGRES_PASSWORD=megaui -e POSTGRES_DB=website \
  -p 5432:5432 postgres:16

export DATABASE_URL=postgres://megaui:megaui@localhost:5432/website
pnpm vitest run packages/database
```

CI already runs a `postgres:16` service with this exact `DATABASE_URL`
(see `.github/workflows/ci.yml`), so these suites always run there. When
`DATABASE_URL` is unset locally, the affected `describe.skipIf` blocks are
skipped with a `console.warn` explaining why. When `CI=true` and
`DATABASE_URL` is unset, the suites hard-fail instead of skipping.

- `src/client.test.ts` — pool release-on-`release()`, timeout-on-exhaustion,
  idle-client eviction, idempotent `close()` (PK-04 AC 3, GC-09).
- `src/migrate.test.ts` — creates a throwaway one-shot database (its own
  `CREATE DATABASE`/`DROP DATABASE`, never touching the database named in
  `DATABASE_URL` itself), applies every migration, re-applies to prove
  idempotency, asserts there are no down-migration files on disk (PK-04
  AC 1 and AC 4, GC-08), and asserts `mega_content_blocks.text_search`
  (generated tsvector) + `mega_content_blocks_fts_idx` (GIN) exist after
  migrating (EG-10, `ADR-FS-01`).
- `src/schema/auth/schema.test.ts` — the four-table field-set check (PK-04
  AC 2).

Run with `pnpm vitest run packages/database` from the repo root (or
`pnpm test` for the whole monorepo, once `DATABASE_URL` is exported).
