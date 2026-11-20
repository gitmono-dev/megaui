CREATE TABLE "feishu_login_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flow_hash" text NOT NULL,
	"flow_seq" integer NOT NULL,
	"email_hmac" text NOT NULL,
	"email_seq" integer NOT NULL,
	"email" text,
	"open_id" text,
	"display_name" text,
	"code_hmac" text,
	"state" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_login_codes_state_check" CHECK ("feishu_login_codes"."state" in ('reserved','active','consumed','void')),
	CONSTRAINT "feishu_login_codes_hold_check" CHECK (("feishu_login_codes"."state" = 'active'
      and "feishu_login_codes"."email" is not null and "feishu_login_codes"."open_id" is not null
      and "feishu_login_codes"."display_name" is not null and "feishu_login_codes"."code_hmac" is not null)
    or ("feishu_login_codes"."state" <> 'active'
      and "feishu_login_codes"."email" is null and "feishu_login_codes"."open_id" is null
      and "feishu_login_codes"."display_name" is null and "feishu_login_codes"."code_hmac" is null))
);
