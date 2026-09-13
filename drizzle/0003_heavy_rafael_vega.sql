CREATE TYPE "public"."availability_exception_kind" AS ENUM('blocked', 'extra');--> statement-breakpoint
CREATE TYPE "public"."payout_method_kind" AS ENUM('mtn_momo', 'orange_money', 'bank');--> statement-breakpoint
CREATE TYPE "public"."qualification_kind" AS ENUM('degree', 'specialisation', 'certification', 'training', 'award');--> statement-breakpoint
CREATE TABLE "availability_exception" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" "availability_exception_kind" NOT NULL,
	"start_time" time,
	"end_time" time,
	"consultation_types" "consultation_type"[],
	"location_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"slot_duration_min" integer NOT NULL,
	"consultation_types" "consultation_type"[] NOT NULL,
	"location_id" uuid,
	"timezone" text DEFAULT 'Africa/Douala' NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultation_offering" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"consultation_type" "consultation_type" NOT NULL,
	"duration_min" integer NOT NULL,
	"price_xaf" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "language" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_fr" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_method" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"kind" "payout_method_kind" NOT NULL,
	"account_name" text NOT NULL,
	"account_number_encrypted" text NOT NULL,
	"account_number_hmac" text NOT NULL,
	"account_number_last_3" text NOT NULL,
	"bank_name" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practitioner_qualification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"kind" "qualification_kind" NOT NULL,
	"title" text NOT NULL,
	"institution" text NOT NULL,
	"country" text NOT NULL,
	"year" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_location" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address_line_1" text NOT NULL,
	"address_line_2" text,
	"city" text NOT NULL,
	"region" text NOT NULL,
	"country" text DEFAULT 'CM' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"consultation_types" "consultation_type"[] NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "cmc_number" text;--> statement-breakpoint
ALTER TABLE "availability_exception" ADD CONSTRAINT "availability_exception_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exception" ADD CONSTRAINT "availability_exception_location_id_practice_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."practice_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_location_id_practice_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."practice_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_offering" ADD CONSTRAINT "consultation_offering_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_method" ADD CONSTRAINT "payout_method_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_qualification" ADD CONSTRAINT "practitioner_qualification_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_location" ADD CONSTRAINT "practice_location_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consultation_offering_profile_type_duration_unique" ON "consultation_offering" USING btree ("practitioner_profile_id","consultation_type","duration_min");--> statement-breakpoint
CREATE UNIQUE INDEX "language_code_unique" ON "language" USING btree ("code");--> statement-breakpoint
INSERT INTO "language" ("id", "code", "name_en", "name_fr") VALUES
	  ('0198e3f0-0000-7000-8000-000000000001', 'en', 'English', 'Anglais'),
	  ('0198e3f0-0000-7000-8000-000000000002', 'fr', 'French', 'Français'),
	  ('0198e3f0-0000-7000-8000-000000000003', 'de', 'German', 'Allemand'),
	  ('0198e3f0-0000-7000-8000-000000000004', 'es', 'Spanish', 'Espagnol'),
	  ('0198e3f0-0000-7000-8000-000000000005', 'ar', 'Arabic', 'Arabe'),
	  ('0198e3f0-0000-7000-8000-000000000006', 'pt', 'Portuguese', 'Portugais'),
	  ('0198e3f0-0000-7000-8000-000000000007', 'sw', 'Swahili', 'Swahili')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
UPDATE "practitioner_profile"
SET "languages_spoken" = ARRAY(
  SELECT CASE lower(trim(value))
    WHEN 'english' THEN 'en' WHEN 'anglais' THEN 'en' WHEN 'en' THEN 'en'
    WHEN 'french' THEN 'fr' WHEN 'français' THEN 'fr' WHEN 'francais' THEN 'fr' WHEN 'fr' THEN 'fr'
    WHEN 'german' THEN 'de' WHEN 'allemand' THEN 'de' WHEN 'de' THEN 'de'
    WHEN 'spanish' THEN 'es' WHEN 'espagnol' THEN 'es' WHEN 'es' THEN 'es'
    WHEN 'arabic' THEN 'ar' WHEN 'arabe' THEN 'ar' WHEN 'ar' THEN 'ar'
    WHEN 'portuguese' THEN 'pt' WHEN 'portugais' THEN 'pt' WHEN 'pt' THEN 'pt'
    WHEN 'swahili' THEN 'sw' WHEN 'sw' THEN 'sw'
    ELSE value
  END
  FROM unnest("languages_spoken") AS value
)
WHERE "languages_spoken" IS NOT NULL;--> statement-breakpoint
INSERT INTO "practice_location" (
  "id", "practitioner_profile_id", "label", "address_line_1", "city", "region", "country",
  "latitude", "longitude", "consultation_types", "is_primary"
)
SELECT "id", "id", 'Primary practice', "location", "location", "location", 'CM',
  "latitude", "longitude", coalesce("consultation_types", ARRAY['in_person'::consultation_type]), true
FROM "practitioner_profile"
WHERE "location" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "consultation_offering" (
  "id", "practitioner_profile_id", "consultation_type", "duration_min", "price_xaf", "active"
)
SELECT (md5(profile."id"::text || ':' || offered.type::text))::uuid, profile."id", offered.type, 30,
  profile."consultation_fee_xaf", true
FROM "practitioner_profile" AS profile
CROSS JOIN LATERAL unnest(coalesce(profile."consultation_types", ARRAY['in_person'::consultation_type])) AS offered(type)
WHERE profile."consultation_fee_xaf" IS NOT NULL
ON CONFLICT ("practitioner_profile_id", "consultation_type", "duration_min") DO NOTHING;
