CREATE TABLE "enterprise_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claim_owner" text,
	"lease_until" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_revocations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"auth_epoch" integer NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enterprise_revocations" ADD CONSTRAINT "enterprise_revocations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_jobs_dedupe_key_uidx" ON "enterprise_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "enterprise_jobs_claim_idx" ON "enterprise_jobs" USING btree ("queue","state","available_at");--> statement-breakpoint
CREATE INDEX "enterprise_jobs_completed_at_idx" ON "enterprise_jobs" USING btree ("completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_revocations_user_epoch_uidx" ON "enterprise_revocations" USING btree ("user_id","auth_epoch");--> statement-breakpoint
CREATE INDEX "enterprise_revocations_delivery_idx" ON "enterprise_revocations" USING btree ("state","created_at");