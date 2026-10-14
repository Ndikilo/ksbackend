CREATE TYPE "public"."notification_channel" AS ENUM('email', 'push', 'sms');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"category" "notification_category" NOT NULL,
	"scenario" text NOT NULL,
	"locale" text NOT NULL,
	"recipient" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"available_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_outbox_attempts_non_negative" CHECK ("notification_outbox"."attempts" >= 0),
	CONSTRAINT "notification_outbox_sent_at_status" CHECK (("notification_outbox"."status" = 'sent') = ("notification_outbox"."sent_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_outbox_user_id_idx" ON "notification_outbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_outbox_drain_idx" ON "notification_outbox" USING btree ("status","available_at");