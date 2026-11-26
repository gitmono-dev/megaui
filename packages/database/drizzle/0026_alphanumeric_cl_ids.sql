ALTER TABLE "mega_cl_public_ids" DROP CONSTRAINT "mega_cl_public_ids_format_check";--> statement-breakpoint
ALTER TABLE "mega_cl_public_ids" ADD COLUMN "underscore_public_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mega_cl_public_ids_underscore_public_id_uidx" ON "mega_cl_public_ids" USING btree ("underscore_public_id") WHERE "mega_cl_public_ids"."underscore_public_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mega_cl_public_ids" ADD CONSTRAINT "mega_cl_public_ids_underscore_format_check" CHECK ("mega_cl_public_ids"."underscore_public_id" COLLATE "C" ~ '^[A-Za-z0-9_]{12}$' AND strpos("mega_cl_public_ids"."underscore_public_id", '_') > 0);--> statement-breakpoint
-- Keep old underscore links alongside any first-generation hyphenated alias.
DO $$
DECLARE
  existing record;
  candidate text;
BEGIN
  FOR existing IN
    SELECT number, public_id FROM mega_cl_public_ids WHERE strpos(public_id, '_') > 0 ORDER BY number
  LOOP
    candidate := replace(existing.public_id, '_', '0');
    WHILE candidate COLLATE "C" !~ '^[A-Za-z0-9]{12}$'
      OR EXISTS (SELECT 1 FROM mega_cl_public_ids WHERE public_id = candidate) LOOP
      candidate := encode(substr(sha256(uuid_send(gen_random_uuid())), 1, 9), 'base64');
    END LOOP;
    UPDATE mega_cl_public_ids
      SET underscore_public_id = existing.public_id, public_id = candidate
      WHERE number = existing.number;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "mega_cl_public_ids" ADD CONSTRAINT "mega_cl_public_ids_format_check" CHECK ("mega_cl_public_ids"."public_id" COLLATE "C" ~ '^[A-Za-z0-9]{12}$');
