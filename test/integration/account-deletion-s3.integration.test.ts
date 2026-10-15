import {
  CreateBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { LocalstackContainer } from "@testcontainers/localstack";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { createTestHarness, type TestHarness, testPassword } from "../support/app-harness";

// P0.T10: beforeDelete's S3 cleanup — deleting an account must remove the
// practitioner's uploaded documents from the real bucket. Exercises the REAL
// S3 driver path (LocalStack) through the full better-auth delete flow.
describe("account deletion S3 cleanup (integration)", () => {
  let container: Awaited<ReturnType<LocalstackContainer["start"]>>;
  let harness: TestHarness;
  let uploader: S3Client;
  const BUCKET = "kanasante-delete-it";
  const saved = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    region: process.env.AWS_REGION,
    addressing: process.env.AWS_S3_ADDRESSING_STYLE,
  };

  beforeAll(async () => {
    container = await new LocalstackContainer("localstack/localstack:3.8.1").start();
    const endpoint = container.getConnectionUri();
    // The S3Client inside auth's beforeDelete mirrors the storage adapter:
    // creds/endpoint from the SDK's default env chain, path-style from
    // S3_FORCE_PATH_STYLE (virtual-host form can't resolve on LocalStack).
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.AWS_ENDPOINT_URL_S3 = endpoint;
    process.env.AWS_REGION = "us-east-1";
    process.env.S3_FORCE_PATH_STYLE = "true";

    const admin = new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    admin.destroy();

    harness = await createTestHarness(undefined, {
      s3: { bucket: BUCKET, region: "us-east-1", forcePathStyle: true },
    });
    uploader = new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  }, 120_000);

  afterAll(async () => {
    await harness.dispose();
    process.env.AWS_ACCESS_KEY_ID = saved.key;
    process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    process.env.AWS_ENDPOINT_URL_S3 = saved.endpoint;
    process.env.AWS_REGION = saved.region;
    process.env.AWS_S3_ADDRESSING_STYLE = saved.addressing;
    await container.stop();
  });

  it("deletes the practitioner's uploaded objects when the account is deleted", async () => {
    const password = testPassword("s3-delete");
    const email = "s3-delete@example.com";
    const cookie = await harness.signUpAndVerify(email, password, "S3 Delete");
    const userId = await harness.userIdFor(email);

    const professionId = crypto.randomUUID();
    await harness.db.insert(profession).values({
      id: professionId,
      nameEn: "IT Doctor",
      nameFr: "Médecin IT",
      prefixHint: "Dr.",
    });

    const keys = [
      `practitioner-documents/${userId}/cmc.pdf`,
      `practitioner-documents/${userId}/nic.pdf`,
      `profile-photos/${userId}/photo.jpg`,
    ];
    await Promise.all(
      keys.map((key) =>
        uploader.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "stub" })),
      ),
    );
    // The three documents exist and are the ONLY objects in the bucket — so the
    // post-delete assertions below cannot pass vacuously.
    const before = await uploader.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    expect(before.Contents).toHaveLength(3);

    await harness.db.insert(practitionerProfile).values({
      id: crypto.randomUUID(),
      userId,
      professionId,
      cmcCertificateFileKey: keys[0],
      nicFileKey: keys[1],
      profilePhotoFileKey: keys[2],
    });

    const deleted = await harness.post("/api/auth/delete-user", { password }, cookie);
    expect([200, 204]).toContain(deleted.status);

    const remainingDocs = await uploader.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "practitioner-documents/" }),
    );
    const remainingPhotos = await uploader.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "profile-photos/" }),
    );
    expect(remainingDocs.Contents ?? []).toHaveLength(0);
    expect(remainingPhotos.Contents ?? []).toHaveLength(0);

    // The DB rows cascaded too (the profile row is what keyed the cleanup).
    const profiles = await harness.db
      .select({ userId: practitionerProfile.userId })
      .from(practitionerProfile)
      .where(eq(practitionerProfile.userId, userId));
    expect(profiles).toHaveLength(0);
  }, 60_000);
});
