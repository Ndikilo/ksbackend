#!/bin/sh
# Runs inside the LocalStack container once S3 is ready (mounted into
# /etc/localstack/init/ready.d). Creates the app's bucket so `bun run infra:up`
# leaves a ready-to-use S3 — no manual `aws s3 mb`. Idempotent.
set -e

BUCKET="kanasante-dev"

awslocal s3 mb "s3://${BUCKET}" 2>/dev/null || true
awslocal s3api put-bucket-cors --bucket "${BUCKET}" --cors-configuration '{
  "CORSRules": [
    { "AllowedMethods": ["PUT", "GET"], "AllowedOrigins": ["*"], "AllowedHeaders": ["*"] }
  ]
}' 2>/dev/null || true

echo "localstack init: bucket ${BUCKET} ready"
