CREATE TABLE "enterprise_directory_identity_watermarks" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_id" text NOT NULL,
	"scope_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_directory_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_directory_watermarks" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_directory_identity_watermarks_identity_uidx" ON "enterprise_directory_identity_watermarks" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "enterprise_directory_identity_watermarks_scope_idx" ON "enterprise_directory_identity_watermarks" USING btree ("scope_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_directory_snapshots_scope_generation_uidx" ON "enterprise_directory_snapshots" USING btree ("scope_hash","generation");--> statement-breakpoint
CREATE INDEX "enterprise_directory_snapshots_scope_observed_idx" ON "enterprise_directory_snapshots" USING btree ("scope_hash","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_directory_watermarks_scope_uidx" ON "enterprise_directory_watermarks" USING btree ("scope_hash");