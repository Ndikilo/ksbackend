import { GetObjectTaggingCommand, S3Client } from "@aws-sdk/client-s3";
import { Config, Context, Effect, Layer } from "effect";

export type ScanStatus = "clean" | "infected" | "pending" | "unscanned" | "error";

/**
 * Malware-scan status of an uploaded object. Actual scanning is AWS-managed
 * (GuardDuty Malware Protection for S3, enabled on the bucket by ops); we read
 * the scan-result object tag. Documents are only accepted once `clean` — every
 * other status (including a failed lookup) is not-yet-provably-safe.
 */
export interface FileScannerService {
  readonly status: (key: string) => Effect.Effect<ScanStatus>;
}

export class FileScanner extends Context.Tag("FileScanner")<FileScanner, FileScannerService>() {}

export const FileScannerS3Live = Layer.effect(
  FileScanner,
  Effect.gen(function* () {
    const bucket = yield* Config.string("S3_BUCKET");
    const region = yield* Config.string("S3_REGION");
    const client = new S3Client({ region });

    return {
      status: (key) =>
        Effect.tryPromise(() =>
          client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key })),
        ).pipe(
          Effect.map((result): ScanStatus => {
            const tag = result.TagSet?.find((t) => t.Key === "GuardDutyMalwareScanStatus")?.Value;
            switch (tag) {
              case "NO_THREATS_FOUND":
                return "clean";
              case "THREATS_FOUND":
                return "infected";
              case undefined:
                return "unscanned";
              default:
                return "pending";
            }
          }),
          // A tagging lookup failure must NOT pass the file through (fail-open);
          // report "error" so the gate rejects it and the client can retry once
          // the lookup recovers. Never silent: log it so it's observable.
          Effect.catchAll((cause) =>
            Effect.logWarning(
              "GuardDuty tag lookup failed; treating file as scan-error",
              cause,
            ).pipe(Effect.zipRight(Effect.succeed<ScanStatus>("error"))),
          ),
        ),
    };
  }),
);

/** Always-clean fake for local/dev/test. */
export const FileScannerCleanLive = Layer.succeed(FileScanner, {
  status: () => Effect.succeed<ScanStatus>("clean"),
});
