# Deploying the API to Render (free test deployment)

The repo ships a [Render blueprint](../render.yaml) that provisions the API and
its Postgres database in one click. The deployed instance runs with
`APP_ENV=staging`: same real drivers as production (real geocoder, real S3
scanner code path, better-auth rate limiting), but the prod-only required
secrets (S3 bucket, RESEND_API_KEY, DATA_ENCRYPTION_KEY / DATA_HMAC_KEY) fall
back to the committed dev defaults so the service boots with minimal setup.

> This is a **test** configuration. Before handling real patient data, switch
> `APP_ENV=prod` and set real values for every `@required=forEnv(prod)` variable
> in `.env.schema`.

## One-click deploy

1. Push/merge this branch to the GitHub repo you want to deploy from.
2. Open: **https://render.com/deploy?repo=<your-repo-url>** (sign in with GitHub
   and allow access to the repo if asked).
3. Render reads `render.yaml` and creates **ksbackend-api** + **ksbackend-db**.
   On the first boot the service runs `drizzle-kit migrate` against the fresh
   database automatically, then starts the API.
4. When it's live, check `https://<your-app>.onrender.com/livez` →
   `{"status":"ok"}`. The API docs are at `/docs` (Scalar) and `/openapi.json`.
   Render itself health-checks `/readyz`, which only reports ok once Postgres
   answers — a deploy is marked healthy when the API can really serve traffic.

Notes on the free tier:

- The web service **spins down after ~15 minutes idle**; the first request
  afterwards takes ~30–60 s while it cold-starts (and re-runs the no-op
  migration check).
- The free Postgres **expires after 30 days** — recreate it or upgrade to keep
  the data.

## Enable OTP emails (real registration)

Without email, accounts can still be created **only** via the seed script (the
seed marks them verified directly in the database) — the mobile app's login flow
works against those. For true sign-up → OTP → verify flows:

1. Create a free API key at [resend.com](https://resend.com).
2. In the Render dashboard → ksbackend-api → Environment, add:
   - `RESEND_API_KEY` — your key.
   - `EMAIL_FROM` = `KanaSanté <onboarding@resend.dev>` while using Resend's
     sandbox sender (it can only deliver to **your own** account's email
     address; verify a domain to email anyone).
3. Save — the service redeploys automatically.

## Seed reference + demo data

With the database URL (Render dashboard → ksbackend-db → _External Database
URL_):

```bash
# from a local clone of this repo (real env vars win over your local .env.local)
DATABASE_URL="<external-db-url>" \
ADMIN_SEED_EMAIL="admin@example.com" \
ADMIN_SEED_PASSWORD="<password>" \
bun run db:seed
```

The seed creates the professions/languages reference rows, a verified admin
account (can log in immediately, no email needed), and — if
`DEMO_PRACTITIONER_EMAIL` is set — enriches that practitioner with location,
qualification, offering, and availability.

## Point the mobile app at the deployment

In the `ksfrontend` repo, set `expo.extra.apiBaseUrl` in `app.json` to
`https://<your-app>.onrender.com` and restart the dev server. Android emulator
users keep the automatic `10.0.2.2` rewrite only for local URLs — a public URL
is used as-is.

## Notifications worker (reminders + outbox drain)

The blueprint also provisions **ksbackend-notifications**, a Render **cron job**
that runs `scripts/notifications-worker.ts` **every 5 minutes** (schedule is
UTC, like all Render cron expressions). One pass:

1. **Scan** — confirmed appointments starting within the next 24 h enter their
   reminder windows (24 h and 1 h before the appointment, Africa/Douala
   discipline: the reminder instant is exact lead-time arithmetic in absolute
   time, and the copy renders the appointment clock in Douala).
2. **Enqueue** — one notification per (appointment, horizon) into the
   `notification_outbox` table, keyed `reminder-24h:<appointmentId>` /
   `reminder-1h:<appointmentId>`. The key has a UNIQUE index: even if two
   passes ever overlap, exactly one row survives (double-send impossible).
   Appointments cancelled before their reminder point are skipped, bookings
   made inside a horizon's window skip that horizon (the booking confirmation
   covered it), and each user's stored notification preferences
   (`appointments` category) gate the channels.
3. **Drain** — due outbox rows are claimed (`FOR UPDATE SKIP LOCKED`) and
   delivered through the channel registry (Resend email; Expo push and SMS
   fail per call with `not_configured` until their credentials exist). Failed
   sends stay in the outbox with a backoff and remain visible.

Operational notes:

- Render runs **at most one instance** of a cron job at a time; the DB-level
  dedup above is the belt-and-braces guarantee (manual triggers, future
  multi-instance setups).
- The job shares the web service's image and database; **no extra secrets**.
  Reminder emails are actually sent only once `RESEND_API_KEY` is configured
  (see the section above) — without it sends log instead of sending.
- Migrations are applied by the **web service** on every deploy/start; the
  cron job never migrates. If you ever enable the cron before the first web
  boot, its passes fail visibly (exit 1) until migrations land — the next
  tick heals.
- Change the cadence in `render.yaml` (`schedule`), e.g. `"*/1 * * * *"` for
  tighter reminder latency; Render bills cron jobs per run second.
- Verify a pass from the dashboard (**Trigger Run**) — the log line prints
  `scan=<n> enqueued=<n> duplicates=<n> skipped=<n> drain(claimed=… sent=…)`.
  `duplicates > 0` means an earlier pass already enqueued those reminders.

## Hardening to production (when ready)

- `APP_ENV=prod` + real values for: `BETTER_AUTH_SECRET`, `DATABASE_URL`,
  `RESEND_API_KEY`, `S3_BUCKET`/`S3_REGION`/AWS credentials,
  `DATA_ENCRYPTION_KEY` + `DATA_HMAC_KEY` (`openssl rand -base64 32` each).
- `SENTRY_DSN` — the api project's DSN from Sentry (error reporting is fully
  disabled while it's unset). Events carry `request_id` + `user_roles` tags so
  they correlate with the request logs.
- `LOG_DRAIN_OTLP_ENDPOINT` (+ `LOG_DRAIN_OTLP_HEADERS`) — optional OTLP sink
  for the wide-event log drain (alert rules in docs/runbook.md); console-only
  while unset.
- `BETTER_AUTH_URL` and `CORS_ORIGINS` are set by the blueprint to the deployed
  https origin (`https://ksbackend-api.onrender.com` + Expo web dev); point them
  at the final production origin (e.g. a custom domain) when you have one —
  `BETTER_AUTH_URL` must stay https so session cookies get the Secure flag.
- Render free Postgres is not HIPAA-grade; use a managed Postgres that matches
  your compliance requirements.
