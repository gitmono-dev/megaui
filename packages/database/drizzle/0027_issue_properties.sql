ALTER TABLE "mega_issues" ADD COLUMN "issue_type" text;--> statement-breakpoint
ALTER TABLE "mega_issues" ADD COLUMN "projects" jsonb DEFAULT '[]'::jsonb NOT NULL;