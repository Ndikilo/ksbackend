import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { LocalstackContainer } from "@testcontainers/localstack";
import { ConfigProvider, Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileStorage, FileStorageS3Live } from "@/infra/storage";

// Exercises the REAL S3 driver (FileStorageS3Live) against a throwaway LocalStack
// so CI proves the actual presign -> upload -> download -> delete path, not a fake.
// Pinned to a Community image tag (no auth token needed for S3).
describe("S3 storage against LocalStack (integration)", () => {
  let container: Awaited<ReturnType<LocalstackContainer["start"]>>;
  const BUCKET = "kanasante-it";
  const saved = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
  };

  beforeAll(async () => {
    container = await new LocalstackContainer("localstack/localstack:3.8.1").start();
    const endpoint = container.getConnectionUri();
    // The AWS SDK reads these from the environment (endpoint + default cred chain).
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.AWS_ENDPOINT_URL_S3 = endpoint;

    const admin = new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    admin.destroy();
  }, 120_000);

  afterAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = saved.key;
    process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    process.env.AWS_ENDPOINT_URL_S3 = saved.endpoint;
    await container.stop();
  });

  it("presigns, uploads, downloads, then deletes a real object", async () => {
    const config = ConfigProvider.fromMap(
      new Map([
        ["S3_BUCKET", BUCKET],
        ["S3_REGION", "us-east-1"],
        ["S3_FORCE_PATH_STYLE", "true"],
      ]),
    ).pipe(ConfigProvider.orElse(() => ConfigProvider.fromEnv()));
    const layer = Layer.provide(FileStorageS3Live, Layer.setConfigProvider(config));

    const body = "hello-localstack";
    const key = "practitioner-documents/it/doc.pdf";

    const program = Effect.gen(function* () {
      const storage = yield* FileStorage;

      const { url } = yield* storage.presignUpload({
        key,
        contentType: "application/pdf",
        maxBytes: body.length,
      });
      const put = yield* Effect.promise(() =>
        fetch(url, { method: "PUT", headers: { "content-type": "application/pdf" }, body }),
      );

      const downloadUrl = yield* storage.presignDownload(key);
      const got = yield* Effect.promise(() => fetch(downloadUrl));
      const text = yield* Effect.promise(() => got.text());

      yield* storage.delete(key);
      const afterDelete = yield* Effect.promise(() => fetch(downloadUrl));

      return {
        putStatus: put.status,
        downloadStatus: got.status,
        text,
        afterDelete: afterDelete.status,
      };
    });

    const res = await Effect.runPromise(Effect.provide(program, layer));

    expect(res.putStatus).toBeLessThan(300); // upload accepted
    expect(res.downloadStatus).toBe(200); // object readable
    expect(res.text).toBe(body); // exact bytes round-tripped
    expect(res.afterDelete).toBeGreaterThanOrEqual(400); // gone after delete
  }, 60_000);
});
