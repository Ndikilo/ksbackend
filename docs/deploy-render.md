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

With the database URL (Render dashboard → ksbackend-db → *External Database
URL*):

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

## Hardening to production (when ready)

- `APP_ENV=prod` + real values for: `BETTER_AUTH_SECRET`, `DATABASE_URL`,
  `RESEND_API_KEY`, `S3_BUCKET`/`S3_REGION`/AWS credentials,
  `DATA_ENCRYPTION_KEY` + `DATA_HMAC_KEY` (`openssl rand -base64 32` each),
  `BETTER_AUTH_URL`, `CORS_ORIGINS`.
- Render free Postgres is not HIPAA-grade; use a managed Postgres that matches
  your compliance requirements.
