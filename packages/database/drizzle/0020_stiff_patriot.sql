CREATE TABLE "feishu_login_key_check" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"key_check" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_login_key_check_single_row_check" CHECK ("feishu_login_key_check"."id" = 1),
	CONSTRAINT "feishu_login_key_check_key_check_check" CHECK ("feishu_login_key_check"."key_check" ~ '^[0-9a-f]{64}$')
);
