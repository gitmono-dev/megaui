ALTER TABLE "mega_cl_public_ids" DROP CONSTRAINT "mega_cl_public_ids_format_check";--> statement-breakpoint
ALTER TABLE "mega_cl_public_ids" ADD COLUMN "legacy_public_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mega_cl_public_ids_legacy_public_id_uidx" ON "mega_cl_public_ids" USING btree ("legacy_public_id") WHERE "mega_cl_public_ids"."legacy_public_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mega_cl_public_ids" ADD CONSTRAINT "mega_cl_public_ids_legacy_format_check" CHECK ("mega_cl_public_ids"."legacy_public_id" COLLATE "C" ~ '^[A-Za-z0-9_-]{12}$' AND strpos("mega_cl_public_ids"."legacy_public_id", '-') > 0);--> statement-breakpoint
-- Keep a shareable alias only for codes that change. The underscore spelling
-- may already belong to another CL, in which case allocate a fresh code.
DO $$
DECLARE
  existing record;
  candidate text;
BEGIN
  FOR existing IN
    SELECT number, public_id FROM mega_cl_public_ids WHERE strpos(public_id, '-') > 0 ORDER BY number
  LOOP
    candidate := replace(existing.public_id, '-', '_');
    WHILE strpos(candidate, '/') > 0 OR EXISTS (SELECT 1 FROM mega_cl_public_ids WHERE public_id = candidate) LOOP
      candidate := replace(encode(substr(sha256(uuid_send(gen_random_uuid())), 1, 9), 'base64'), '+', '_');
    END LOOP;
    UPDATE mega_cl_public_ids
      SET legacy_public_id = existing.public_id, public_id = candidate
      WHERE number = existing.number;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "mega_cl_public_ids" ADD CONSTRAINT "mega_cl_public_ids_format_check" CHECK ("mega_cl_public_ids"."public_id" COLLATE "C" ~ '^[A-Za-z0-9_]{12}$');
