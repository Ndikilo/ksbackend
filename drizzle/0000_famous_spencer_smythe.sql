CREATE TYPE "public"."admin_scope" AS ENUM('super_admin', 'verification_reviewer');--> statement-breakpoint
CREATE TYPE "public"."caregiver_link_status" AS ENUM('pending', 'active', 'revoked', 'declined');--> statement-breakpoint
CREATE TYPE "public"."consent_event" AS ENUM('invited', 'accepted', 'declined', 'revoked', 'upgraded');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('appointments', 'verification', 'security', 'account');--> statement-breakpoint
CREATE TYPE "public"."relationship" AS ENUM('child', 'parent', 'spouse', 'sibling', 'other');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "public"."verification_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('incomplete', 'pending_verification', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE "admin_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" "admin_scope" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_profile_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text DEFAULT 'patient',
	"locale" text DEFAULT 'fr',
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caregiver_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"caregiver_user_id" text NOT NULL,
	"managed_dependent_id" uuid,
	"subject_user_id" text,
	"relationship" "relationship" NOT NULL,
	"status" "caregiver_link_status" NOT NULL,
	"invite_identifier" text,
	"invite_token" text,
	"expires_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "caregiver_link_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
CREATE TABLE "consent_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"link_id" uuid NOT NULL,
	"actor_user_id" text,
	"event" "consent_event" NOT NULL,
	"meta" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"surname" text NOT NULL,
	"given_names" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"sex" "sex" NOT NULL,
	"phone" text,
	"location" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category" "notification_category" NOT NULL,
	"email" boolean NOT NULL,
	"sms" boolean NOT NULL,
	"push" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preference_user_id_category_unique" UNIQUE("user_id","category")
);
--> statement-breakpoint
CREATE TABLE "patient_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"emergency_contact_relationship" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_profile_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "practitioner_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"profession_id" uuid NOT NULL,
	"prefix" text,
	"location" text,
	"specialty" text,
	"bio" text,
	"languages_spoken" text[],
	"years_experience" integer,
	"consultation_fee_xaf" integer,
	"cmc_number_encrypted" text,
	"cmc_number_hmac" text,
	"nic_number_encrypted" text,
	"nic_number_hmac" text,
	"cmc_certificate_file_key" text,
	"nic_file_key" text,
	"profile_photo_file_key" text,
	"verification_status" "verification_status" DEFAULT 'incomplete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practitioner_profile_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "practitioner_profile_cmc_number_hmac_unique" UNIQUE("cmc_number_hmac"),
	CONSTRAINT "practitioner_profile_nic_number_hmac_unique" UNIQUE("nic_number_hmac")
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"surname" text NOT NULL,
	"given_names" text NOT NULL,
	"phone" text,
	"date_of_birth" date,
	"sex" "sex",
	"avatar_file_key" text,
	"consent_accepted_at" timestamp with time zone NOT NULL,
	"consent_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "profession" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_fr" text NOT NULL,
	"prefix_hint" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"decision" "verification_decision" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_profile" ADD CONSTRAINT "admin_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_link" ADD CONSTRAINT "caregiver_link_caregiver_user_id_user_id_fk" FOREIGN KEY ("caregiver_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_link" ADD CONSTRAINT "caregiver_link_managed_dependent_id_dependent_id_fk" FOREIGN KEY ("managed_dependent_id") REFERENCES "public"."dependent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_link" ADD CONSTRAINT "caregiver_link_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_audit" ADD CONSTRAINT "consent_audit_link_id_caregiver_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."caregiver_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_audit" ADD CONSTRAINT "consent_audit_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_profile" ADD CONSTRAINT "patient_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD CONSTRAINT "practitioner_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD CONSTRAINT "practitioner_profile_profession_id_profession_id_fk" FOREIGN KEY ("profession_id") REFERENCES "public"."profession"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_review" ADD CONSTRAINT "verification_review_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_review" ADD CONSTRAINT "verification_review_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");