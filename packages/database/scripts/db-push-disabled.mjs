#!/usr/bin/env node
/* eslint-disable no-undef -- plain Node script (not part of the TS
   project/globals config); `process` is a Node global at runtime. */
// ADR-FS-01 Consequences #7 (EG-10): `drizzle-kit push` diffs the live
// database against the Drizzle *model*, and `text_search` (generated
// column + GIN index, `drizzle/0002_body_fts.sql`) is intentionally not
// modeled (see `src/schema/mega/mega-content.ts`). An unmodified `db:push`
// would therefore see that column as unmanaged drift and offer to drop it.
//
// `db:push` is hard-disabled instead of merely documented as discouraged —
// this script never invokes `drizzle-kit push` and always exits non-zero.
process.stderr.write(
  [
    "[@megaui/database] db:push is disabled (ADR-FS-01 Consequences #7).",
    "`drizzle-kit push` diffs against the Drizzle model, which does not",
    "include mega_content_blocks.text_search (generated column + GIN index,",
    "drizzle/0002_body_fts.sql) — an unmanaged push could drop it.",
    "Use `pnpm --filter @megaui/database run db:migrate` instead.",
    "",
  ].join("\n"),
);
process.exit(1);
