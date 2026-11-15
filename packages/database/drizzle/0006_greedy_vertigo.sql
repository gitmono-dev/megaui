CREATE TABLE "enterprise_admin_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"verb" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"expected_user_version" integer,
	"expected_identity_version" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_batch_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"batch_number" integer NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_quarantine" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'quarantined' NOT NULL,
	"operation_id" text,
	"manifest_digest" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enterprise_quarantine" ADD CONSTRAINT "enterprise_quarantine_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_admin_operations_operation_id_uidx" ON "enterprise_admin_operations" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "enterprise_admin_operations_state_idx" ON "enterprise_admin_operations" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_batch_checkpoints_operation_batch_uidx" ON "enterprise_batch_checkpoints" USING btree ("operation_id","batch_number");--> statement-breakpoint
CREATE INDEX "enterprise_batch_checkpoints_digest_idx" ON "enterprise_batch_checkpoints" USING btree ("manifest_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_quarantine_user_id_uidx" ON "enterprise_quarantine" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "enterprise_quarantine_state_idx" ON "enterprise_quarantine" USING btree ("state");