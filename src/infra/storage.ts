import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Config, Context, Data, Effect, Layer } from "effect";

export type PresignedUpload = { readonly url: string; readonly key: string };

export class StorageError extends Data.TaggedError("StorageError")<{ readonly reason: string }> {}

/**
 * File storage seam. Large uploads (documents, photos ≤25 MB) NEVER travel
 * through the API (1 MB body limit) — the client uploads directly to storage via
 * a presigned URL and we persist only the key. One S3 bucket, key-prefixed per
 * concern (docs/AUTH_PLAN.md §5). Real S3 in prod; a fake for local/test.
 */
export interface FileStorageService {
  readonly presignUpload: (input: {
    readonly key: string;
    readonly contentType: string;
    readonly maxBytes: number;
  }) => Effect.Effect<PresignedUpload, StorageError>;
  readonly presignDownload: (key: string) => Effect.Effect<string, StorageError>;
  readonly delete: (key: string) => Effect.Effect<void, StorageError>;
}

export class FileStorage extends Context.Tag("FileStorage")<FileStorage, FileStorageService>() {}

export const FileStorageS3Live = Layer.effect(
  FileStorage,
  Effect.gen(function* () {
    const bucket = yield* Config.string("S3_BUCKET");
    const region = yield* Config.string("S3_REGION");
    // Path-style addressing for S3-compatible emulators (LocalStack) where the
    // virtual-host form (bucket.host) can't resolve. Off = real AWS. The endpoint
    // itself comes from the SDK's native AWS_ENDPOINT_URL_S3; credentials from the
    // SDK's default env chain.
    const forcePathStyle = yield* Config.boolean("S3_FORCE_PATH_STYLE").pipe(
      Config.withDefault(false),
    );
    const uploadTtlSeconds = yield* Config.integer("S3_UPLOAD_PRESIGN_TTL_SECONDS").pipe(
      Config.withDefault(300),
    );
    const downloadTtlSeconds = yield* Config.integer("S3_DOWNLOAD_PRESIGN_TTL_SECONDS").pipe(
      Config.withDefault(3600),
    );
    // The SDK adds default request checksums (CRC32) to PutObject; a presigned URL
    // then demands a checksum header the uploading client (browser/RN/curl) won't
    // send, so the PUT 400s. WHEN_REQUIRED disables that so plain uploads work.
    const client = new S3Client({
      region,
      forcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
    });

    const attempt = <A>(thunk: () => Promise<A>) =>
      Effect.tryPromise({
        try: thunk,
        catch: (cause) => new StorageError({ reason: String(cause) }),
      });

    return {
      presignUpload: ({ key, contentType, maxBytes }) =>
        attempt(async () => {
          const url = await getSignedUrl(
            client,
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              ContentType: contentType,
              ContentLength: maxBytes,
            }),
            { expiresIn: uploadTtlSeconds },
          );
          return { url, key };
        }),
      presignDownload: (key) =>
        attempt(() =>
          getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
            expiresIn: downloadTtlSeconds,
          }),
        ),
      delete: (key) =>
        attempt(async () => {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        }),
    };
  }),
);

/** In-memory fake — returns non-functional URLs so flows run without S3. */
export const FileStorageFakeLive = Layer.succeed(FileStorage, {
  presignUpload: ({ key }) =>
    Effect.succeed({ url: `https://fake-storage.local/upload/${key}`, key }),
  presignDownload: (key) => Effect.succeed(`https://fake-storage.local/download/${key}`),
  delete: () => Effect.void,
});
