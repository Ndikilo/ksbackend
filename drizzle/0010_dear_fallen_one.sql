CREATE TYPE "public"."appointment_status" AS ENUM('pending', 'confirmed', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_user_id" text NOT NULL,
	"dependent_id" uuid,
	"practitioner_profile_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"consultation_offering_id" uuid NOT NULL,
	"status" "appointment_status" DEFAULT 'pending' NOT NULL,
	"consultation_type" "consultation_type" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"price_xaf" integer NOT NULL,
	"cancellation_notice_hours" integer NOT NULL,
	"cancellation_fee_xaf" integer DEFAULT 0 NOT NULL,
	"late_cancellation" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_time_order" CHECK ("appointment"."ends_at" > "appointment"."starts_at"),
	CONSTRAINT "appointment_price_nonnegative" CHECK ("appointment"."price_xaf" >= 0),
	CONSTRAINT "appointment_notice_nonnegative" CHECK ("appointment"."cancellation_notice_hours" >= 0),
	CONSTRAINT "appointment_fee_nonnegative" CHECK ("appointment"."cancellation_fee_xaf" >= 0),
	CONSTRAINT "appointment_cancelled_has_timestamp" CHECK (("appointment"."status" = 'cancelled') = ("appointment"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_user_id_user_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_dependent_id_dependent_id_fk" FOREIGN KEY ("dependent_id") REFERENCES "public"."dependent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_slot_id_availability_slot_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."availability_slot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_consultation_offering_id_consultation_offering_id_fk" FOREIGN KEY ("consultation_offering_id") REFERENCES "public"."consultation_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_cancelled_by_user_id_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_patient_user_starts_idx" ON "appointment" USING btree ("patient_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_practitioner_starts_idx" ON "appointment" USING btree ("practitioner_profile_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_dependent_id_idx" ON "appointment" USING btree ("dependent_id");--> statement-breakpoint
CREATE INDEX "appointment_slot_id_idx" ON "appointment" USING btree ("slot_id");--> statement-breakpoint
CREATE INDEX "appointment_consultation_offering_id_idx" ON "appointment" USING btree ("consultation_offering_id");--> statement-breakpoint
CREATE INDEX "appointment_cancelled_by_user_id_idx" ON "appointment" USING btree ("cancelled_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_slot_active_unique" ON "appointment" USING btree ("slot_id") WHERE "appointment"."status" in ('pending', 'confirmed');