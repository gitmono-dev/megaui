-- megaui:libs/database/drizzle/0011_body_fts.sql@0ff3a9d
--
-- Hand-written (not `drizzle-kit generate`d): the generated `text_search`
-- column is intentionally absent from the Drizzle model (see
-- `src/schema/mega/mega-content.ts`'s `megaContentBlocks` comment), so
-- drizzle-kit would never diff it into a migration on its own. ADR-FS-01 §②
-- / EG-10 Consequences #1.
--
-- English-only tsvector (ADR-FS-01 §① / §②): `to_tsvector('english', ...)`
-- treats a whole CJK sentence as a single token (no zhparser/jieba in
-- postgres:15-alpine), so this column/index deliberately does not serve CJK
-- substring recall — that's EG-14's `position()` window path, not this file.
ALTER TABLE "mega_content_blocks"
  ADD COLUMN "text_search" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("text_summary", ''))) STORED;
--> statement-breakpoint
CREATE INDEX "mega_content_blocks_fts_idx" ON "mega_content_blocks" USING gin ("text_search");
