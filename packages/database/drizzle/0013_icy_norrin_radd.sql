CREATE TABLE "enterprise_login_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"deployment_role" text NOT NULL,
	"local_user_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"identity_version" integer NOT NULL,
	"auth_epoch" integer NOT NULL,
	"flow_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recover_until" timestamp with time zone NOT NULL,
	CONSTRAINT "enterprise_login_grants_binding_check" CHECK ("enterprise_login_grants"."deployment_role" in ('development','test','production','canary')
    and "enterprise_login_grants"."purpose" = 'login' and "enterprise_login_grants"."identity_version" > 0 and "enterprise_login_grants"."auth_epoch" >= 0
    and "enterprise_login_grants"."generation" > 0 and "enterprise_login_grants"."flow_hash" ~ '^[0-9a-f]{64}$'
    and char_length("enterprise_login_grants"."scope") between 1 and 256 and "enterprise_login_grants"."scope" ~ '[^[:space:]]'),
	CONSTRAINT "enterprise_login_grants_lifetime_check" CHECK (isfinite("enterprise_login_grants"."created_at")
    and isfinite("enterprise_login_grants"."recover_until") and "enterprise_login_grants"."recover_until" > "enterprise_login_grants"."created_at"
    and "enterprise_login_grants"."recover_until" <= "enterprise_login_grants"."created_at" + interval '390 seconds')
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "enterprise_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "enterprise_identity_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "auth_epoch" integer;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "auth_method" text;--> statement-breakpoint
ALTER TABLE "enterprise_login_grants" ADD CONSTRAINT "enterprise_login_grants_challenge_id_enterprise_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."enterprise_challenges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_login_grants" ADD CONSTRAINT "enterprise_login_grants_scope_enterprise_policy_scope_fk" FOREIGN KEY ("scope") REFERENCES "public"."enterprise_policy"("scope") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_login_grants" ADD CONSTRAINT "enterprise_login_grants_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_login_grants" ADD CONSTRAINT "enterprise_login_grants_identity_id_enterprise_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."enterprise_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_login_grants_challenge_uidx" ON "enterprise_login_grants" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "enterprise_login_grants_recover_until_idx" ON "enterprise_login_grants" USING btree ("recover_until");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_enterprise_grant_id_enterprise_login_grants_id_fk" FOREIGN KEY ("enterprise_grant_id") REFERENCES "public"."enterprise_login_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_enterprise_identity_id_enterprise_identity_id_fk" FOREIGN KEY ("enterprise_identity_id") REFERENCES "public"."enterprise_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_enterprise_grant_uidx" ON "session" USING btree ("enterprise_grant_id");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_enterprise_metadata_check" CHECK ((
    ("session"."enterprise_grant_id" is null and "session"."enterprise_identity_id" is null
      and "session"."auth_epoch" is null and "session"."auth_method" is null)
    or ("session"."enterprise_grant_id" is not null and "session"."enterprise_identity_id" is not null
      and "session"."auth_epoch" is not null and "session"."auth_epoch" >= 0
      and "session"."auth_method" is not null and char_length("session"."auth_method") between 1 and 64
      and "session"."auth_method" ~ '^[A-Za-z0-9._:-]+$')
  ));