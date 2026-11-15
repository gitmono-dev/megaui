ALTER TABLE "enterprise_notification_outbox" DROP CONSTRAINT "enterprise_notification_outbox_fields_check";--> statement-breakpoint
ALTER TABLE "enterprise_notification_outbox" ALTER COLUMN "destination_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "enterprise_notification_outbox" ADD CONSTRAINT "enterprise_notification_outbox_fields_check" CHECK (("enterprise_notification_outbox"."destination_email" is null or (char_length("enterprise_notification_outbox"."destination_email") between 1 and 320
        and "enterprise_notification_outbox"."destination_email" !~ '[[:space:]]'))
        and char_length("enterprise_notification_outbox"."destination_version") between 1 and 256
        and "enterprise_notification_outbox"."destination_version" !~ '[[:space:]]'
        and char_length("enterprise_notification_outbox"."recipient_name") between 1 and 256
        and char_length("enterprise_notification_outbox"."device") between 1 and 512
        and char_length("enterprise_notification_outbox"."source") between 1 and 512
        and char_length("enterprise_notification_outbox"."app_name") between 1 and 256
        and "enterprise_notification_outbox"."app_url" ~ '^https?://[^?#[:space:]]+$');