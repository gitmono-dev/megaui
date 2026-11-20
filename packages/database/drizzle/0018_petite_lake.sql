CREATE TABLE "feishu_identities" (
	"app_id" text NOT NULL,
	"open_id_hmac" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_identities_app_open_id_hmac_unique" UNIQUE("app_id","open_id_hmac"),
	CONSTRAINT "feishu_identities_user_app_unique" UNIQUE("user_id","app_id"),
	CONSTRAINT "feishu_identities_open_id_hmac_check" CHECK ("feishu_identities"."open_id_hmac" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "feishu_identities" ADD CONSTRAINT "feishu_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;