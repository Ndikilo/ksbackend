import { GetObjectTaggingCommand, S3Client } from "@aws-sdk/client-s3";
import { Config, Context, Effect, Layer } from "effect";

export type ScanStatus = "clean" | "infected" | "pending" | "unscanned";

/**
 * Malware-scan status of an uploaded object. Actual scanning is AWS-managed
 * (GuardDuty Malware Protection for S3, enabled on the bucket by ops); we read
 * the scan-result object tag. Documents are only accepted/served once `clean`.
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
          // A tagging lookup failure shouldn't crash the flow; treat as unscanned
          // (fail-open) — but never silently: surface it so it's observable.
          Effect.catchAll((cause) =>
            Effect.logWarning(
              "GuardDuty tag lookup failed; treating file as unscanned",
              cause,
            ).pipe(Effect.zipRight(Effect.succeed<ScanStatus>("unscanned"))),
          ),
        ),
    };
  }),
);

/** Always-clean fake for local/dev/test. */
export const FileScannerCleanLive = Layer.succeed(FileScanner, {
  status: () => Effect.succeed<ScanStatus>("clean"),
});
