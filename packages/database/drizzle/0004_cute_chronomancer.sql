CREATE TABLE "enterprise_identity" (
	"id" text PRIMARY KEY NOT NULL,
	"local_user_id" text NOT NULL,
	"tenant_key" text NOT NULL,
	"app_id" text NOT NULL,
	"open_id" text NOT NULL,
	"union_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"identity_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"owner_fingerprint" text NOT NULL,
	"deployment_role" text NOT NULL,
	"environment" text NOT NULL,
	"auth_epoch" integer DEFAULT 0 NOT NULL,
	"activation_state" text DEFAULT 'legacy' NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_policy_scope_unique" UNIQUE("scope"),
	CONSTRAINT "enterprise_policy_activation_state_check" CHECK ("enterprise_policy"."activation_state" in ('legacy', 'maintenance', 'enterprise')),
	CONSTRAINT "enterprise_policy_auth_epoch_check" CHECK ("enterprise_policy"."auth_epoch" >= 0),
	CONSTRAINT "enterprise_policy_legacy_epoch_check" CHECK ("enterprise_policy"."activation_state" <> 'legacy' or "enterprise_policy"."auth_epoch" = 0)
);
--> statement-breakpoint
CREATE TABLE "enterprise_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL,
	"login_name" text NOT NULL,
	"backend_username" text NOT NULL,
	"display_name" text,
	"notification_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_profile_login_name_format_check" CHECK ("enterprise_profile"."login_name" ~ '^[a-z0-9][a-z0-9._-]{2,63}$')
);
--> statement-breakpoint
ALTER TABLE "enterprise_identity" ADD CONSTRAINT "enterprise_identity_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_profile" ADD CONSTRAINT "enterprise_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_identity_tenant_app_open_uidx" ON "enterprise_identity" USING btree ("tenant_key","app_id","open_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_identity_local_tenant_app_uidx" ON "enterprise_identity" USING btree ("local_user_id","tenant_key","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_profile_tenant_login_name_uidx" ON "enterprise_profile" USING btree ("tenant_key","login_name");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_profile_backend_username_uidx" ON "enterprise_profile" USING btree ("backend_username");