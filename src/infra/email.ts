import { Config, Context, Data, Effect, Layer, Redacted } from "effect";
import { Resend } from "resend";

export type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
};

export class EmailError extends Data.TaggedError("EmailError")<{ readonly reason: string }> {}

/** Effect email seam for OUR emails (verification-decision notifications, etc.). */
export interface EmailSenderService {
  readonly send: (message: EmailMessage) => Effect.Effect<void, EmailError>;
}
export class EmailSender extends Context.Tag("EmailSender")<EmailSender, EmailSenderService>() {}

/**
 * Plain (Promise-based) client for better-auth's emailOTP callback, which runs
 * OUTSIDE Effect. Backed by the same Resend account as the Effect `EmailSender`.
 */
export type EmailClient = { readonly send: (message: EmailMessage) => Promise<void> };

/**
 * `baseUrl` points the Resend SDK somewhere other than the real API — locally at
 * resend-local (http://localhost:8005) so email is captured in its dashboard
 * instead of sent. When omitted the SDK also honors a `RESEND_BASE_URL` env var,
 * so `RESEND_BASE_URL=… bun run dev` works without setting it in config.
 */
export const makeResendClient = (apiKey: string, from: string, baseUrl?: string): EmailClient => {
  const resend = new Resend(apiKey, baseUrl !== undefined ? { baseUrl } : undefined);
  return {
    send: async ({ to, subject, html }) => {
      const { error } = await resend.emails.send({ from, to, subject, html });
      if (error) throw new Error(error.message);
    },
  };
};

/** Dev/console client — prints instead of sending (no Resend account needed locally). */
export const makeConsoleClient = (): EmailClient => ({
  send: ({ to, subject, html }) =>
    Promise.resolve(console.log(`[email:dev] to=${to} subject="${subject}"\n${html}`)),
});

export const EmailSenderResendLive = Layer.effect(
  EmailSender,
  Effect.gen(function* () {
    const apiKey = Redacted.value(yield* Config.redacted("RESEND_API_KEY"));
    const from = yield* Config.string("EMAIL_FROM");
    const baseUrl = yield* Config.string("RESEND_BASE_URL").pipe(Config.withDefault(""));
    const client = makeResendClient(apiKey, from, baseUrl === "" ? undefined : baseUrl);
    return {
      send: (message) =>
        Effect.tryPromise({
          try: () => client.send(message),
          catch: (cause) => new EmailError({ reason: String(cause) }),
        }),
    };
  }),
);

/** Console-backed Effect sender for local/dev/test. */
export const EmailSenderConsoleLive = Layer.sync(EmailSender, () => {
  const client = makeConsoleClient();
  return {
    send: (message) =>
      Effect.tryPromise({
        try: () => client.send(message),
        catch: (cause) => new EmailError({ reason: String(cause) }),
      }),
  };
});
