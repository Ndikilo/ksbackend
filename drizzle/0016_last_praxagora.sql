CREATE TYPE "public"."phone_otp_channel" AS ENUM('sms', 'email', 'dev');--> statement-breakpoint
CREATE TYPE "public"."phone_registration_purpose" AS ENUM('signup', 'attach');--> statement-breakpoint
CREATE TABLE "phone_identity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"phone" text NOT NULL,
	"channel" "phone_otp_channel" NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_identity_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "phone_identity_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "phone_verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"purpose" "phone_registration_purpose" NOT NULL,
	"user_id" text,
	"email" text,
	"name" text,
	"password_hash" text,
	"locale" text DEFAULT 'fr' NOT NULL,
	"code_hash" text NOT NULL,
	"delivered_via" "phone_otp_channel" NOT NULL,
	"send_count" integer DEFAULT 1 NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verification_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "phone_identity" ADD CONSTRAINT "phone_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD CONSTRAINT "phone_verification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_verification_user_id_idx" ON "phone_verification" USING btree ("user_id");