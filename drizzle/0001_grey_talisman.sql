CREATE TYPE "public"."availability_slot_status" AS ENUM('open', 'booked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."consultation_type" AS ENUM('in_person', 'video', 'home_visit');--> statement-breakpoint
CREATE TABLE "availability_slot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "availability_slot_status" DEFAULT 'open' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_slot_time_order" CHECK ("availability_slot"."ends_at" > "availability_slot"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_rating_range" CHECK ("review"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "consultation_types" "consultation_type"[];--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "rating_average" numeric(3, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "availability_slot" ADD CONSTRAINT "availability_slot_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_open_future_idx" ON "availability_slot" USING btree ("practitioner_profile_id","starts_at") WHERE "availability_slot"."status" = 'open' and "availability_slot"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_one_active_per_pair" ON "review" USING btree ("reviewer_user_id","practitioner_profile_id") WHERE "review"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "review_practitioner_active_idx" ON "review" USING btree ("practitioner_profile_id") WHERE "review"."deleted_at" is null;