ALTER TABLE "notification_outbox" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedup_key_unique" ON "notification_outbox" USING btree ("dedup_key");