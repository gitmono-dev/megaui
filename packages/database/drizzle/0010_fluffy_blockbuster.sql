CREATE TABLE "enterprise_actor_inventory" (
	"scope" text PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"source_digest" text NOT NULL,
	"subjects_digest" text NOT NULL,
	"ownership_digest" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"upstream_actors" jsonb NOT NULL,
	CONSTRAINT "enterprise_actor_inventory_source_digest_check" CHECK ("enterprise_actor_inventory"."source_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enterprise_actor_inventory_subjects_digest_check" CHECK ("enterprise_actor_inventory"."subjects_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enterprise_actor_inventory_ownership_digest_check" CHECK ("enterprise_actor_inventory"."ownership_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enterprise_actor_inventory_observed_at_check" CHECK (isfinite("enterprise_actor_inventory"."observed_at")),
	CONSTRAINT "enterprise_actor_inventory_upstream_actors_check" CHECK (jsonb_typeof("enterprise_actor_inventory"."upstream_actors") = 'array')
);
--> statement-breakpoint
ALTER TABLE "enterprise_actor_inventory" ADD CONSTRAINT "enterprise_actor_inventory_scope_enterprise_policy_scope_fk" FOREIGN KEY ("scope") REFERENCES "public"."enterprise_policy"("scope") ON DELETE no action ON UPDATE no action;