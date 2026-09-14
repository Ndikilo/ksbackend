#!/bin/sh
# Container entrypoint: apply migrations, then run the API in the foreground.
# `exec` makes bun PID 1 so SIGTERM reaches it (graceful drain on redeploys).
set -e
bun scripts/migrate.ts
exec bun src/server.ts
