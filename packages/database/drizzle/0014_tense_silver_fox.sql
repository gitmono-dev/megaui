CREATE TABLE "enterprise_notification_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"destination_email" text NOT NULL,
	"destination_version" text NOT NULL,
	"recipient_name" text NOT NULL,
	"login_at" timestamp with time zone NOT NULL,
	"device" text NOT NULL,
	"source" text NOT NULL,
	"app_name" text NOT NULL,
	"app_url" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"last_error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_notification_outbox_state_check" CHECK ("enterprise_notification_outbox"."state" in ('pending','sending','sent','skipped','failed')),
	CONSTRAINT "enterprise_notification_outbox_locale_check" CHECK ("enterprise_notification_outbox"."locale" in ('en','zh-CN')),
	CONSTRAINT "enterprise_notification_outbox_fields_check" CHECK (char_length("enterprise_notification_outbox"."destination_email") between 1 and 320
        and "enterprise_notification_outbox"."destination_email" !~ '[[:space:]]'
        and char_length("enterprise_notification_outbox"."destination_version") between 1 and 256
        and "enterprise_notification_outbox"."destination_version" !~ '[[:space:]]'
        and char_length("enterprise_notification_outbox"."recipient_name") between 1 and 256
        and char_length("enterprise_notification_outbox"."device") between 1 and 512
        and char_length("enterprise_notification_outbox"."source") between 1 and 512
        and char_length("enterprise_notification_outbox"."app_name") between 1 and 256
        and "enterprise_notification_outbox"."app_url" ~ '^https?://[^?#[:space:]]+$'),
	CONSTRAINT "enterprise_notification_outbox_attempts_check" CHECK ("enterprise_notification_outbox"."attempts" >= 0),
	CONSTRAINT "enterprise_notification_outbox_lifetime_check" CHECK (isfinite("enterprise_notification_outbox"."login_at")
        and isfinite("enterprise_notification_outbox"."available_at")
        and isfinite("enterprise_notification_outbox"."created_at")
        and isfinite("enterprise_notification_outbox"."expires_at")
        and "enterprise_notification_outbox"."expires_at" > "enterprise_notification_outbox"."created_at"
        and "enterprise_notification_outbox"."expires_at" <= "enterprise_notification_outbox"."created_at" + interval '31 days'),
	CONSTRAINT "enterprise_notification_outbox_terminal_check" CHECK ((
        "enterprise_notification_outbox"."state" in ('pending','sending','failed')
          and "enterprise_notification_outbox"."sent_at" is null
          and "enterprise_notification_outbox"."skipped_at" is null
      ) or (
        "enterprise_notification_outbox"."state" = 'sent'
          and "enterprise_notification_outbox"."sent_at" is not null
          and "enterprise_notification_outbox"."skipped_at" is null
      ) or (
        "enterprise_notification_outbox"."state" = 'skipped'
          and "enterprise_notification_outbox"."sent_at" is null
          and "enterprise_notification_outbox"."skipped_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "enterprise_notification_outbox" ADD CONSTRAINT "enterprise_notification_outbox_grant_id_enterprise_login_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."enterprise_login_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_notification_outbox_grant_uidx" ON "enterprise_notification_outbox" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "enterprise_notification_outbox_delivery_idx" ON "enterprise_notification_outbox" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "enterprise_notification_outbox_expires_at_idx" ON "enterprise_notification_outbox" USING btree ("expires_at");