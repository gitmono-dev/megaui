CREATE TABLE "enterprise_event_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL,
	"app_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_created_at" timestamp with time zone NOT NULL,
	"subject_open_id" text,
	"message_id" text,
	"sender_open_id" text,
	"sender_type" text,
	"chat_type" text,
	"message_type" text,
	"pairing_token_digest" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"claim_owner" text,
	"lease_until" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_event_inbox_state_known" CHECK ("enterprise_event_inbox"."state" in ('pending', 'leased', 'done')),
	CONSTRAINT "enterprise_event_inbox_message_id_required" CHECK ("enterprise_event_inbox"."event_type" <> 'im.message.receive_v1' or ("enterprise_event_inbox"."message_id" is not null and "enterprise_event_inbox"."message_id" ~ '[^[:space:]]')),
	CONSTRAINT "enterprise_event_inbox_state_fields" CHECK ((
        "enterprise_event_inbox"."state" = 'pending'
        and "enterprise_event_inbox"."claim_owner" is null
        and "enterprise_event_inbox"."lease_until" is null
        and "enterprise_event_inbox"."completed_at" is null
      ) or (
        "enterprise_event_inbox"."state" = 'leased'
        and "enterprise_event_inbox"."claim_owner" is not null
        and "enterprise_event_inbox"."claim_owner" ~ '[^[:space:]]'
        and "enterprise_event_inbox"."lease_until" is not null
        and "enterprise_event_inbox"."completed_at" is null
      ) or (
        "enterprise_event_inbox"."state" = 'done'
        and "enterprise_event_inbox"."claim_owner" is null
        and "enterprise_event_inbox"."lease_until" is null
        and "enterprise_event_inbox"."completed_at" is not null
      )),
	CONSTRAINT "enterprise_event_inbox_pairing_digest_shape" CHECK ("enterprise_event_inbox"."pairing_token_digest" is null or "enterprise_event_inbox"."pairing_token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enterprise_event_inbox_pairing_digest_message" CHECK ("enterprise_event_inbox"."pairing_token_digest" is null or ("enterprise_event_inbox"."message_id" is not null and "enterprise_event_inbox"."message_id" ~ '[^[:space:]]'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_event_inbox_tenant_app_event_uidx" ON "enterprise_event_inbox" USING btree ("tenant_key","app_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_event_inbox_tenant_app_message_uidx" ON "enterprise_event_inbox" USING btree ("tenant_key","app_id","message_id") WHERE "enterprise_event_inbox"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "enterprise_event_inbox_pending_claim_idx" ON "enterprise_event_inbox" USING btree ("available_at","id") WHERE "enterprise_event_inbox"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "enterprise_event_inbox_lease_claim_idx" ON "enterprise_event_inbox" USING btree ("lease_until","id") WHERE "enterprise_event_inbox"."state" = 'leased';--> statement-breakpoint
CREATE INDEX "enterprise_event_inbox_cleanup_idx" ON "enterprise_event_inbox" USING btree ("state","completed_at","id");