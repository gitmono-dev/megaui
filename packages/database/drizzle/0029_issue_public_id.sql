ALTER TABLE "mega_issues" ADD COLUMN "public_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mega_issues_public_id_uidx" ON "mega_issues" USING btree ("public_id");--> statement-breakpoint
DO $$
DECLARE issue_id text; candidate text;
BEGIN
  FOR issue_id IN SELECT id FROM mega_issues LOOP
    LOOP
      candidate := encode(substr(sha256(uuid_send(gen_random_uuid())), 1, 9), 'base64');
      IF candidate !~ '^[A-Za-z0-9]{12}$' THEN CONTINUE; END IF;
      BEGIN
        UPDATE mega_issues SET public_id = candidate WHERE id = issue_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "mega_issues" ALTER COLUMN "public_id" SET DEFAULT substring(replace(gen_random_uuid()::text, '-', '') from 1 for 12);--> statement-breakpoint
ALTER TABLE "mega_issues" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mega_issues" ADD CONSTRAINT "mega_issues_public_id_format_check" CHECK ("public_id" COLLATE "C" ~ '^[A-Za-z0-9]{12}$');
