CREATE TABLE "mega_cl_public_ids" (
	"number" integer PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	CONSTRAINT "mega_cl_public_ids_format_check" CHECK ("mega_cl_public_ids"."public_id" COLLATE "C" ~ '^[A-Za-z0-9_-]{12}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mega_cl_public_ids_public_id_uidx" ON "mega_cl_public_ids" USING btree ("public_id");
--> statement-breakpoint
-- A local row and its pre-existing live mapping share one public identity.
-- Encode nine random bytes as twelve URL-safe symbols, matching document block IDs.
DO $$
DECLARE
  cl_number integer;
  candidate text;
BEGIN
  FOR cl_number IN SELECT number FROM mega_cls UNION SELECT number FROM mega_cl_links LOOP
    LOOP
      candidate := translate(encode(substr(sha256(uuid_send(gen_random_uuid())), 1, 9), 'base64'), '+/', '_-');
      INSERT INTO mega_cl_public_ids (number, public_id) VALUES (cl_number, candidate)
        ON CONFLICT (public_id) DO NOTHING;
      EXIT WHEN FOUND;
    END LOOP;
  END LOOP;
END $$;
