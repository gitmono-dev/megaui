CREATE TABLE "enterprise_dm_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge_id" uuid NOT NULL,
	"delivery_key_id" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "enterprise_dm_deliveries_envelope_check" CHECK ("enterprise_dm_deliveries"."delivery_key_id" ~ '^[A-Za-z0-9._-]{1,128}$'
    and char_length("enterprise_dm_deliveries"."encrypted_payload") between 48 and 8192 and "enterprise_dm_deliveries"."encrypted_payload" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "enterprise_dm_deliveries_lifetime_check" CHECK (isfinite("enterprise_dm_deliveries"."created_at") and isfinite("enterprise_dm_deliveries"."expires_at") and "enterprise_dm_deliveries"."expires_at" > "enterprise_dm_deliveries"."created_at"
    and ("enterprise_dm_deliveries"."first_attempt_at" is null or (isfinite("enterprise_dm_deliveries"."first_attempt_at") and "enterprise_dm_deliveries"."first_attempt_at" >= "enterprise_dm_deliveries"."created_at"))
    and ("enterprise_dm_deliveries"."sent_at" is null or (isfinite("enterprise_dm_deliveries"."sent_at") and "enterprise_dm_deliveries"."sent_at" >= "enterprise_dm_deliveries"."created_at")))
);
--> statement-breakpoint
CREATE TABLE "enterprise_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"deployment_role" text NOT NULL,
	"local_user_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"identity_version" integer NOT NULL,
	"flow_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"pairing_id" uuid,
	"code_hmac" text,
	"hmac_key_id" text,
	"state" text DEFAULT 'active' NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"recover_until" timestamp with time zone,
	"secret_expires_at" timestamp with time zone NOT NULL,
	"secret_cleared_at" timestamp with time zone,
	CONSTRAINT "enterprise_challenges_id_expiry_unique" UNIQUE("id","expires_at"),
	CONSTRAINT "enterprise_challenges_binding_check" CHECK ("enterprise_challenges"."deployment_role" in ('development','test','production','canary')
    and "enterprise_challenges"."purpose" = 'login' and "enterprise_challenges"."generation" > 0 and "enterprise_challenges"."identity_version" > 0
    and "enterprise_challenges"."flow_hash" ~ '^[0-9a-f]{64}$' and "enterprise_challenges"."failed_attempts" between 0 and 5),
	CONSTRAINT "enterprise_challenges_state_check" CHECK ("enterprise_challenges"."state" in ('active','consumed','superseded','revoked','expired')),
	CONSTRAINT "enterprise_challenges_lifetime_check" CHECK (isfinite("enterprise_challenges"."created_at") and isfinite("enterprise_challenges"."expires_at") and isfinite("enterprise_challenges"."secret_expires_at")
    and "enterprise_challenges"."expires_at" = "enterprise_challenges"."created_at" + interval '300 seconds'
    and "enterprise_challenges"."secret_expires_at" >= "enterprise_challenges"."created_at" and "enterprise_challenges"."secret_expires_at" <= coalesce("enterprise_challenges"."recover_until", "enterprise_challenges"."expires_at")
    and ("enterprise_challenges"."state" <> 'active' or "enterprise_challenges"."secret_expires_at" = "enterprise_challenges"."expires_at")
    and ("enterprise_challenges"."state" <> 'consumed' or "enterprise_challenges"."secret_expires_at" = "enterprise_challenges"."recover_until")),
	CONSTRAINT "enterprise_challenges_consumption_check" CHECK ((
    ("enterprise_challenges"."consumed_at" is null and "enterprise_challenges"."recover_until" is null)
    or ("enterprise_challenges"."consumed_at" is not null and "enterprise_challenges"."recover_until" is not null
      and isfinite("enterprise_challenges"."consumed_at") and isfinite("enterprise_challenges"."recover_until")
      and "enterprise_challenges"."consumed_at" >= "enterprise_challenges"."created_at" and "enterprise_challenges"."consumed_at" < "enterprise_challenges"."expires_at"
      and "enterprise_challenges"."recover_until" = "enterprise_challenges"."consumed_at" + interval '90 seconds'))
    and ("enterprise_challenges"."state" <> 'consumed' or "enterprise_challenges"."consumed_at" is not null)
    and ("enterprise_challenges"."state" <> 'active' or "enterprise_challenges"."consumed_at" is null)),
	CONSTRAINT "enterprise_challenges_secret_check" CHECK ((
    ("enterprise_challenges"."code_hmac" is not null and "enterprise_challenges"."hmac_key_id" is not null and "enterprise_challenges"."secret_cleared_at" is null
      and "enterprise_challenges"."code_hmac" ~ '^[0-9a-f]{64}$' and "enterprise_challenges"."hmac_key_id" ~ '^[A-Za-z0-9._-]{1,128}$')
    or ("enterprise_challenges"."code_hmac" is null and "enterprise_challenges"."hmac_key_id" is null and "enterprise_challenges"."secret_cleared_at" is not null
      and isfinite("enterprise_challenges"."secret_cleared_at") and "enterprise_challenges"."secret_cleared_at" >= "enterprise_challenges"."secret_expires_at"))
    and ("enterprise_challenges"."state" <> 'active' or "enterprise_challenges"."code_hmac" is not null))
);
--> statement-breakpoint
CREATE TABLE "enterprise_login_budgets" (
	"scope" text NOT NULL,
	"deployment_role" text NOT NULL,
	"budget_kind" text NOT NULL,
	"subject_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_allowed_at" timestamp with time zone,
	CONSTRAINT "enterprise_login_budgets_scope_key_pk" PRIMARY KEY("scope","deployment_role","budget_kind","subject_hash","window_started_at"),
	CONSTRAINT "enterprise_login_budgets_binding_check" CHECK ("enterprise_login_budgets"."deployment_role" in ('development','test','production','canary')
    and "enterprise_login_budgets"."budget_kind" in ('anonymous-ip','sender-send','sender-invalid','verify-failure')
    and "enterprise_login_budgets"."subject_hash" ~ '^[0-9a-f]{64}$' and "enterprise_login_budgets"."used" >= 0),
	CONSTRAINT "enterprise_login_budgets_lifetime_check" CHECK (isfinite("enterprise_login_budgets"."window_started_at") and isfinite("enterprise_login_budgets"."expires_at")
    and "enterprise_login_budgets"."expires_at" > "enterprise_login_budgets"."window_started_at" and ("enterprise_login_budgets"."next_allowed_at" is null or isfinite("enterprise_login_budgets"."next_allowed_at")))
);
--> statement-breakpoint
CREATE TABLE "enterprise_pairings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"deployment_role" text NOT NULL,
	"tenant_key" text NOT NULL,
	"app_id" text NOT NULL,
	"flow_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"token_hash" text NOT NULL,
	"intended_identity_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"confirmed_identity_version" integer,
	"confirmed_message_id" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "enterprise_pairings_binding_check" CHECK ("enterprise_pairings"."deployment_role" in ('development','test','production','canary')
    and "enterprise_pairings"."purpose" = 'login' and "enterprise_pairings"."generation" > 0
    and "enterprise_pairings"."flow_hash" ~ '^[0-9a-f]{64}$' and "enterprise_pairings"."token_hash" ~ '^[0-9a-f]{64}$'
    and char_length("enterprise_pairings"."tenant_key") between 1 and 256 and "enterprise_pairings"."tenant_key" ~ '[^[:space:]]'
    and char_length("enterprise_pairings"."app_id") between 1 and 256 and "enterprise_pairings"."app_id" ~ '[^[:space:]]'),
	CONSTRAINT "enterprise_pairings_state_check" CHECK ("enterprise_pairings"."state" in ('pending','confirmed','expired')),
	CONSTRAINT "enterprise_pairings_confirmation_check" CHECK ((
    ("enterprise_pairings"."confirmed_at" is null and "enterprise_pairings"."confirmed_message_id" is null and "enterprise_pairings"."confirmed_identity_version" is null)
    or ("enterprise_pairings"."confirmed_at" is not null and "enterprise_pairings"."confirmed_message_id" is not null and "enterprise_pairings"."confirmed_identity_version" is not null
      and "enterprise_pairings"."intended_identity_id" is not null and "enterprise_pairings"."confirmed_identity_version" > 0
      and char_length("enterprise_pairings"."confirmed_message_id") between 1 and 256 and "enterprise_pairings"."confirmed_message_id" ~ '[^[:space:]]'))
    and ("enterprise_pairings"."state" <> 'pending' or "enterprise_pairings"."confirmed_at" is null)
    and ("enterprise_pairings"."state" <> 'confirmed' or "enterprise_pairings"."confirmed_at" is not null)),
	CONSTRAINT "enterprise_pairings_lifetime_check" CHECK (isfinite("enterprise_pairings"."created_at") and isfinite("enterprise_pairings"."expires_at") and isfinite("enterprise_pairings"."retain_until")
    and "enterprise_pairings"."expires_at" = "enterprise_pairings"."created_at" + interval '120 seconds'
    and ("enterprise_pairings"."confirmed_at" is null or (isfinite("enterprise_pairings"."confirmed_at") and "enterprise_pairings"."confirmed_at" >= "enterprise_pairings"."created_at" and "enterprise_pairings"."confirmed_at" < "enterprise_pairings"."expires_at"))
    and "enterprise_pairings"."retain_until" = coalesce("enterprise_pairings"."confirmed_at" + interval '390 seconds', "enterprise_pairings"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "enterprise_dm_deliveries" ADD CONSTRAINT "enterprise_dm_deliveries_challenge_expiry_fk" FOREIGN KEY ("challenge_id","expires_at") REFERENCES "public"."enterprise_challenges"("id","expires_at") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_challenges" ADD CONSTRAINT "enterprise_challenges_scope_enterprise_policy_scope_fk" FOREIGN KEY ("scope") REFERENCES "public"."enterprise_policy"("scope") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_challenges" ADD CONSTRAINT "enterprise_challenges_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_challenges" ADD CONSTRAINT "enterprise_challenges_identity_id_enterprise_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."enterprise_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_challenges" ADD CONSTRAINT "enterprise_challenges_pairing_id_enterprise_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."enterprise_pairings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_login_budgets" ADD CONSTRAINT "enterprise_login_budgets_scope_enterprise_policy_scope_fk" FOREIGN KEY ("scope") REFERENCES "public"."enterprise_policy"("scope") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_pairings" ADD CONSTRAINT "enterprise_pairings_scope_enterprise_policy_scope_fk" FOREIGN KEY ("scope") REFERENCES "public"."enterprise_policy"("scope") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_pairings" ADD CONSTRAINT "enterprise_pairings_identity_fk" FOREIGN KEY ("intended_identity_id") REFERENCES "public"."enterprise_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_dm_deliveries_challenge_uidx" ON "enterprise_dm_deliveries" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "enterprise_dm_deliveries_expires_at_idx" ON "enterprise_dm_deliveries" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_challenges_flow_generation_uidx" ON "enterprise_challenges" USING btree ("scope","deployment_role","purpose","flow_hash","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_challenges_active_flow_uidx" ON "enterprise_challenges" USING btree ("scope","deployment_role","purpose","flow_hash") WHERE "enterprise_challenges"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_challenges_pairing_uidx" ON "enterprise_challenges" USING btree ("pairing_id");--> statement-breakpoint
CREATE INDEX "enterprise_challenges_expires_at_idx" ON "enterprise_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "enterprise_challenges_secret_expiry_idx" ON "enterprise_challenges" USING btree ("secret_expires_at") WHERE "enterprise_challenges"."code_hmac" is not null;--> statement-breakpoint
CREATE INDEX "enterprise_login_budgets_expires_at_idx" ON "enterprise_login_budgets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_pairings_token_hash_uidx" ON "enterprise_pairings" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_pairings_flow_generation_uidx" ON "enterprise_pairings" USING btree ("scope","deployment_role","purpose","flow_hash","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_pairings_pending_flow_uidx" ON "enterprise_pairings" USING btree ("scope","deployment_role","purpose","flow_hash") WHERE "enterprise_pairings"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_pairings_message_uidx" ON "enterprise_pairings" USING btree ("scope","tenant_key","app_id","confirmed_message_id") WHERE "enterprise_pairings"."confirmed_message_id" is not null;--> statement-breakpoint
CREATE INDEX "enterprise_pairings_retain_until_idx" ON "enterprise_pairings" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "enterprise_pairings_identity_state_idx" ON "enterprise_pairings" USING btree ("scope","intended_identity_id","state");