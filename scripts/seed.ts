#!/usr/bin/env bun
/**
 * Idempotent seed: the initial professions and the first admin account.
 * Run via `bun run db:seed` (wraps `varlock run`). Reads env directly (edge script).
 */
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { v7 as uuidv7 } from "uuid";
import { adminProfile } from "../src/db/schema/admin-profile";
import { user } from "../src/db/schema/auth";
import { profession } from "../src/db/schema/profession";
import { language } from "../src/db/schema/language";
import { practitionerProfile } from "../src/db/schema/practitioner-profile";
import { practitionerQualification } from "../src/db/schema/practitioner-qualification";
import { practiceLocation } from "../src/db/schema/practice-location";
import { consultationOffering } from "../src/db/schema/consultation-offering";
import { availabilityRule } from "../src/db/schema/availability-rule";
import { makeAuth } from "../src/infra/auth";
import { makeConsoleClient } from "../src/infra/email";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://kanasante:kanasante@localhost:5432/kanasante";

const db = drizzle(databaseUrl);

const professions = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    nameEn: "Doctor (General Practitioner)",
    nameFr: "Médecin (généraliste)",
    prefixHint: "Dr.",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    nameEn: "Specialist Physician",
    nameFr: "Médecin spécialiste",
    prefixHint: "Dr.",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    nameEn: "Nurse",
    nameFr: "Infirmier / Infirmière",
    prefixHint: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    nameEn: "Midwife",
    nameFr: "Sage-femme",
    prefixHint: null,
  },
];

const languages = [
  { id: "0198e3f0-0000-7000-8000-000000000001", code: "en", nameEn: "English", nameFr: "Anglais" },
  { id: "0198e3f0-0000-7000-8000-000000000002", code: "fr", nameEn: "French", nameFr: "Français" },
  { id: "0198e3f0-0000-7000-8000-000000000003", code: "de", nameEn: "German", nameFr: "Allemand" },
  { id: "0198e3f0-0000-7000-8000-000000000004", code: "es", nameEn: "Spanish", nameFr: "Espagnol" },
  { id: "0198e3f0-0000-7000-8000-000000000005", code: "ar", nameEn: "Arabic", nameFr: "Arabe" },
  {
    id: "0198e3f0-0000-7000-8000-000000000006",
    code: "pt",
    nameEn: "Portuguese",
    nameFr: "Portugais",
  },
  { id: "0198e3f0-0000-7000-8000-000000000007", code: "sw", nameEn: "Swahili", nameFr: "Swahili" },
];

const seedProfessions = async (): Promise<void> => {
  await Promise.all(
    professions.map((row) =>
      db.insert(profession).values(row).onConflictDoNothing({ target: profession.id }),
    ),
  );
  console.log(`✓ seeded ${professions.length} professions`);
};

const seedLanguages = async (): Promise<void> => {
  await Promise.all(
    languages.map((row) =>
      db.insert(language).values(row).onConflictDoNothing({ target: language.code }),
    ),
  );
  console.log(`✓ seeded ${languages.length} languages`);
};

const seedDemoPractitionerDetail = async (): Promise<void> => {
  const email = process.env.DEMO_PRACTITIONER_EMAIL;
  if (!email) {
    console.log("• DEMO_PRACTITIONER_EMAIL not set — skipping practitioner detail seed");
    return;
  }
  const rows = await db
    .select({ profile: practitionerProfile })
    .from(practitionerProfile)
    .innerJoin(user, eq(user.id, practitionerProfile.userId))
    .where(eq(user.email, email))
    .limit(1);
  const found = rows[0]?.profile;
  if (found === undefined) {
    console.log(`• no practitioner profile for ${email} — skipping practitioner detail seed`);
    return;
  }

  const locations = await db
    .select({ id: practiceLocation.id })
    .from(practiceLocation)
    .where(
      and(eq(practiceLocation.practitionerProfileId, found.id), isNull(practiceLocation.deletedAt)),
    )
    .limit(1);
  const locationId = locations[0]?.id ?? uuidv7();
  if (locations.length === 0) {
    await db.insert(practiceLocation).values({
      id: locationId,
      practitionerProfileId: found.id,
      label: "Primary practice",
      addressLine1: found.location ?? "Douala",
      city: found.location ?? "Douala",
      region: "Littoral",
      consultationTypes: ["in_person"],
      isPrimary: true,
      latitude: found.latitude,
      longitude: found.longitude,
    });
  }
  const qualifications = await db
    .select({ id: practitionerQualification.id })
    .from(practitionerQualification)
    .where(
      and(
        eq(practitionerQualification.practitionerProfileId, found.id),
        isNull(practitionerQualification.deletedAt),
      ),
    )
    .limit(1);
  if (qualifications.length === 0) {
    await db.insert(practitionerQualification).values({
      id: uuidv7(),
      practitionerProfileId: found.id,
      kind: "degree",
      title: "Doctor of Medicine",
      institution: "Faculty of Medicine and Biomedical Sciences",
      country: "CM",
      year: 2015,
    });
  }
  await db
    .insert(consultationOffering)
    .values({
      id: uuidv7(),
      practitionerProfileId: found.id,
      consultationType: "in_person",
      durationMin: 30,
      priceXaf: found.consultationFeeXaf ?? 10_000,
    })
    .onConflictDoNothing();
  const rules = await db
    .select({ id: availabilityRule.id })
    .from(availabilityRule)
    .where(eq(availabilityRule.practitionerProfileId, found.id))
    .limit(1);
  if (rules.length === 0) {
    const consultationTypes: Array<"in_person"> = ["in_person"];
    await db.insert(availabilityRule).values(
      [1, 2, 3, 4, 5].map((weekday) => ({
        id: uuidv7(),
        practitionerProfileId: found.id,
        weekday,
        startTime: "09:00",
        endTime: "17:00",
        slotDurationMin: 30,
        consultationTypes: [...consultationTypes],
        locationId,
      })),
    );
  }
  console.log(`✓ seeded practitioner detail data for ${email}`);
};

const seedAdmin = async (): Promise<void> => {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !password) {
    console.log("• ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD not set — skipping admin seed");
    return;
  }

  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existing.length > 0) {
    console.log(`• admin ${email} already exists — skipping`);
    return;
  }

  const auth = makeAuth({
    databaseUrl,
    secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-insecure-secret-change-in-production-000",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    defaultLocale: "fr",
    emailClient: makeConsoleClient(),
  });
  await auth.instance.api.signUpEmail({ body: { email, password, name: "KanaSanté Admin" } });
  await db.update(user).set({ role: "admin", emailVerified: true }).where(eq(user.email, email));
  const admin = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  const adminId = admin[0]?.id;
  if (adminId !== undefined) {
    await db
      .insert(adminProfile)
      .values({ id: uuidv7(), userId: adminId, scope: "super_admin" })
      .onConflictDoNothing({ target: adminProfile.userId });
  }
  await auth.close();
  console.log(`✓ seeded admin ${email}`);
};

await seedProfessions();
await seedLanguages();
await seedAdmin();
await seedDemoPractitionerDetail();
await db.$client.end();
console.log("Seed complete.");
