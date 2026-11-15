CREATE TABLE "enterprise_actor_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"backend_username" text NOT NULL,
	"actor_state" text DEFAULT 'reserved' NOT NULL,
	"identity_id" text,
	"local_user_id" text,
	"quarantined" boolean DEFAULT false NOT NULL,
	"source_snapshot_digest" text NOT NULL,
	"source_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_actor_reservations_quarantine_check" CHECK ("enterprise_actor_reservations"."quarantined" = false or "enterprise_actor_reservations"."actor_state" = 'reserved')
);
--> statement-breakpoint
ALTER TABLE "enterprise_actor_reservations" ADD CONSTRAINT "enterprise_actor_reservations_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_actor_reservations_backend_username_uidx" ON "enterprise_actor_reservations" USING btree ("backend_username");--> statement-breakpoint
CREATE INDEX "enterprise_actor_reservations_state_idx" ON "enterprise_actor_reservations" USING btree ("actor_state");--> statement-breakpoint
CREATE INDEX "enterprise_actor_reservations_snapshot_idx" ON "enterprise_actor_reservations" USING btree ("source_snapshot_digest");