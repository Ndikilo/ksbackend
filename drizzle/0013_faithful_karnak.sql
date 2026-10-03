CREATE TYPE "public"."payment_provider" AS ENUM('momo', 'orange_money');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('initiated', 'pending', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"payer_user_id" text NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"status" "payment_status" DEFAULT 'initiated' NOT NULL,
	"amount_xaf" integer NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"provider_charge_id" text,
	"provider_reference" text,
	"failure_reason" text,
	"receipt_number" text,
	"receipt_issued_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refund_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_positive" CHECK ("payment"."amount_xaf" > 0),
	CONSTRAINT "payment_refunded_has_timestamp" CHECK (("payment"."status" = 'refunded') = ("payment"."refunded_at" is not null)),
	CONSTRAINT "payment_receipt_only_when_paid" CHECK ("payment"."receipt_number" is null or "payment"."status" in ('succeeded', 'refunded'))
);
--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_payer_user_id_user_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_appointment_id_idx" ON "payment" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "payment_payer_user_id_idx" ON "payment" USING btree ("payer_user_id");--> statement-breakpoint
CREATE INDEX "payment_provider_charge_id_idx" ON "payment" USING btree ("provider_charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_idempotency_key_unique" ON "payment" USING btree ("idempotency_key");