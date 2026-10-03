# KanaSanté API — Operations Runbook

Operational procedures for the deployed API (Render web service + Render
Postgres). Sections: [Alerting](#alerting) · [Restore from backup](#restore-from-backup) ·
[Secret rotation](#secret-rotation) · [Incident checklist](#incident-checklist).

## Alerting

Signals come from three places:

1. **Wide-event logs** — every request emits one structured event
   (method, path, status, duration, requestId, user roles, error code). Local
   console sink always; additionally to any OTLP/HTTP endpoint when
   `LOG_DRAIN_OTLP_ENDPOINT` is set (Grafana Cloud, Axiom, Datadog, a
   self-hosted collector). Auth headers via `LOG_DRAIN_OTLP_HEADERS`.
2. **Sentry error events** — unhandled 5xx reach Sentry when `SENTRY_DSN` is
   set, tagged with `request_id` + `user_roles` so events correlate with logs.
3. **Render platform checks** — the `/readyz` health check powers zero-downtime
   deploys and its failure history is visible in the dashboard.

Sinks and Sentry projects are account-level setup (free tiers suffice); see the
user-action registry in `PROGRESS.md` for the exact steps.

### Alert rules to configure in the log sink

All rules assume the OTLP drain is connected. Field names per evlog wide
events: `http.status_code` (int), `http.path`, `error_code`, `request_id`,
`user.roles`. Tune thresholds after a week of real traffic.

| #   | Alert                                           | Condition (window)                                                                                                                                      | Why                                                                                                | First response                                                                                                                                                                                               |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | **5xx rate**                                    | `http.status_code >= 500` as a share of all requests > 2% over 5 min, OR > 20 absolute 5xx in 5 min                                                     | Code/regression, DB pool exhaustion, upstream (S3/Resend/geo) outage                               | Check Sentry for the dominant exception; `Render logs → grep error_code`; if `INTERNAL` spikes after a deploy, roll back the deploy                                                                          |
| A2  | **OTP failure spike**                           | `http.path` starts with `/api/auth/` AND `http.status_code >= 400` on `email-otp/*` routes > 20 in 10 min                                               | Either the Resend domain/quota broke (users can't sign in at all) or someone is brute-forcing OTPs | Distinguish by error shape: send failures (Resend 4xx/5xx) vs verify failures (401 invalid OTP). Verify failures from few IPs = attack → the better-auth rate limiter already caps sends; consider IP blocks |
| A3  | **Readiness flaps**                             | Render health-check notification for `/readyz` (503), OR drained `http.path = /readyz` events with `http.status_code = 503` more than 3 times in 15 min | DB unreachable/pool exhausted — booking, auth, and everything DB-backed is down or about to be     | Render Postgres status page first; then `SELECT 1` via psql; check pool saturation (`DB_POOL_MAX`), restart the service if the pool is wedged                                                                |
| A4  | **Sentry new-issue spike** (when UA-3 is wired) | > 10 events of a single new issue in 1 h                                                                                                                | Regression shipped                                                                                 | Triage by `request_id` ↔ log drain correlation; roll back if introduced by the latest deploy                                                                                                                 |

Minimum viable setup without a log sink: enable **Render health-check
notifications** (covers A3 partially) and Sentry alert rule A4 (covers A1
coarsely). The log-drain rules A1/A2/A3 are strictly better — set them up when
the sink exists.

## Restore from backup

Render Postgres on a paid plan takes daily automatic backups (free tier does
NOT — see the launch checklist). Practice this on a scratch database once
before you ever need it for real (the launch checklist includes a test
restore).

1. **Grab the latest backup.** Render dashboard → the Postgres instance →
   _Backups_ → download the newest `.sql.gz` (a custom-format `pg_dump`).
2. **Provision a scratch target.** Either a second Render Postgres instance,
   or locally: `docker compose up -d postgres` (from `ksbackend/`).
3. **Restore.**
   ```bash
   # into a fresh, empty database
   pg_restore --no-owner --no-privileges \
     --dbname "postgres://kanasante:kanasante@localhost:5432/kanasante_restore" \
     latest.dump
   ```
   Do NOT restore over the live database in place — restore beside it, verify,
   then cut over.
4. **Verify the restore** (minimum set):
   ```sql
   SELECT count(*) FROM "user";                 -- accounts present
   SELECT count(*) FROM practitioner_profile;   -- practitioners present
   SELECT count(*) FROM caregiver_link;         -- care relationships present
   SELECT count(*) FROM payout_method;          -- payout records present
   SELECT max("createdAt") FROM "user";         -- recency ≈ backup time
   ```
   Then boot the API against the restored DB (`DATABASE_URL=… bun run dev`)
   and smoke-test: sign in with a known account, `GET /v1/me`.
5. **Cut over** — update `DATABASE_URL` on the Render service to the restored
   instance, deploy/restart, watch `/readyz` and A1/A3 alerts.

RPO ≈ 24 h (daily backups) unless a point-in-time upgrade is purchased; RTO ≈
the time it takes steps 1–5 (~30 min if practiced).

## Secret rotation

All secrets live in Render env (and locally in `.env.local`, never committed).

| Secret                                        | Rotation steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                          | Render env → set a new `openssl rand -base64 32` value → deploy. **All sessions/cookies are invalidated** (users sign in again; OTPs in flight fail once). Do it in a quiet window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RESEND_API_KEY`                              | Resend dashboard → create a new API key → set on Render → deploy → delete the old key in Resend. Sending briefly fails if the order is wrong; rotate after a deploy window, not before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DATA_ENCRYPTION_KEY` (at-rest AES)           | **Read this fully first.** Values are encrypted with this key in `practitioner_profile.nic_number_encrypted` / `.cmc_number_encrypted` and `payout_method.account_number_encrypted`. To rotate: decrypt-then-re-encrypt every row of those three columns under the new key inside one maintenance window. There is no key-version column today, so a rolling rotation is impossible — schedule it, script it, verify row counts before/after.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DATA_HMAC_KEY` (blind index)                 | **The re-hash trap:** lookups are deterministic — a NIC/CMC/payout number is found by HMAC-ing it with _this_ key into `practitioner_profile.nic_number_hmac` / `.cmc_number_hmac` and `payout_method.account_number_hmac`. Rotating the key changes every index, so a naive env swap makes all existing rows unfindable (search-by-identity and payout dedupe silently break). Procedure: (1) add shadow columns `*_hmac_new` in a migration; (2) for every row, recompute the index by decrypting the paired `*_encrypted` value with `DATA_ENCRYPTION_KEY` and HMAC-ing it with the NEW key; (3) verify `count(*)` where `*_hmac_new IS NULL` = 0; (4) in ONE release: swap the column names (migration) + set `DATA_HMAC_KEY` to the new value on Render; (5) drop the old columns in a follow-up migration. Never just rotate the env var. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS IAM → create a new key pair for the app user → set on Render → deploy → disable the old key after the fleet has rolled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ADMIN_SEED_PASSWORD`                         | Not an env-trusted value post-seed — rotate by signing in as the admin and changing the password in-app (it's hashed in the DB). Rotate the env value too, so future seeds don't resurrect it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Incident checklist

1. **Declare** — note the UTC start time, symptoms, and who is on it (even if
   it's one person); post status when user-facing.
2. **Stabilize** — is a deploy the trigger? Roll back on Render (Deploys →
   _Roll back_). Is the DB the trigger? Check Render Postgres metrics
   (CPU, connections) and A3 above.
3. **Observe** — Sentry issue + log-drain query for the dominant
   `error_code`; correlate with `request_id`. Decide blast radius: auth-only?
   booking? everything?
4. **Mitigate** — known-bad data → feature isn't shippable? Prefer disabling
   the affected flow at the edge (e.g. a 503 route) over hotfix-under-pressure.
5. **Verify recovery** — `/readyz` green for 15 min, A1/A2/A3 quiet, one
   successful smoke pass: register → verify → search → book → pay (sandbox).
6. **Close** — note the UTC end time; within a week write a short postmortem
   (timeline, root cause, what would have caught it) and file the follow-up
   task in `PROGRESS.md`. Never blame; fix systems.
