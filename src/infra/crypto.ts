import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";

export class DecryptError extends Data.TaggedError("DecryptError")<{ readonly reason: string }> {}

export interface CryptoService {
  /** Encrypt a value for at-rest storage (AES-256-GCM). Never fails at runtime. */
  readonly encrypt: (plaintext: string) => Effect.Effect<string>;
  /** Decrypt a stored value. Fails if the payload is corrupt or tampered with. */
  readonly decrypt: (ciphertext: string) => Effect.Effect<string, DecryptError>;
  /** Deterministic keyed digest — for equality/uniqueness checks without decrypting. */
  readonly hmac: (value: string) => string;
}

/**
 * App-level encryption seam. Used for sensitive identifiers (NIC/CMC numbers)
 * that admins must be able to READ back to verify against uploaded documents —
 * hence encryption, not hashing. The paired `hmac` gives dedupe/uniqueness on a
 * value without decrypting it. Keys come from varlock (`DATA_ENCRYPTION_KEY`,
 * `DATA_HMAC_KEY` — 32-byte base64, `@sensitive`).
 */
export class Crypto extends Context.Tag("Crypto")<Crypto, CryptoService>() {}

const decodeKey = (base64: string, name: string): Buffer => {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} must decode to 32 bytes (base64); got ${key.length}`);
  }
  return key;
};

export const CryptoLive = Layer.effect(
  Crypto,
  Effect.gen(function* () {
    const encryptionKey = decodeKey(
      Redacted.value(yield* Config.redacted("DATA_ENCRYPTION_KEY")),
      "DATA_ENCRYPTION_KEY",
    );
    const hmacKey = decodeKey(
      Redacted.value(yield* Config.redacted("DATA_HMAC_KEY")),
      "DATA_HMAC_KEY",
    );

    return {
      encrypt: (plaintext) =>
        Effect.sync(() => {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
          const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          return [
            iv.toString("base64"),
            cipher.getAuthTag().toString("base64"),
            encrypted.toString("base64"),
          ].join(".");
        }),

      decrypt: (ciphertext) =>
        Effect.try({
          try: () => {
            const [iv, tag, payload] = ciphertext.split(".");
            if (iv === undefined || tag === undefined || payload === undefined) {
              throw new Error("malformed ciphertext");
            }
            const decipher = createDecipheriv(
              "aes-256-gcm",
              encryptionKey,
              Buffer.from(iv, "base64"),
            );
            decipher.setAuthTag(Buffer.from(tag, "base64"));
            return Buffer.concat([
              decipher.update(Buffer.from(payload, "base64")),
              decipher.final(),
            ]).toString("utf8");
          },
          catch: (cause) => new DecryptError({ reason: String(cause) }),
        }),

      hmac: (value) => createHmac("sha256", hmacKey).update(value, "utf8").digest("base64"),
    };
  }),
);
