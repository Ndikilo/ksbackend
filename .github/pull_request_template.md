## What does this PR do?

<!--
Give reviewers the context they need.
Explain the problem and the approach taken — not just a list of changed files.
-->

### Summary

<!-- Briefly describe the change. -->

### Why?

<!--
Why is this change necessary?
Link the issue/ticket/design doc where applicable.
-->

Closes #

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] Performance improvement
- [ ] Database / migration
- [ ] Infrastructure / DevOps
- [ ] Security
- [ ] Dependency update
- [ ] Documentation
- [ ] Other

## How was this implemented?

<!--
Call out important implementation decisions, trade-offs,
new abstractions, architectural changes, or non-obvious behavior.
-->

## API changes

<!-- Delete this section if not applicable. -->

- [ ] No API changes
- [ ] Backwards-compatible API change
- [ ] Breaking API change

### Endpoints affected

<!--
Example:
POST /v1/payments
GET  /v1/payments/:id
-->

### Request / response changes

<!-- Include examples where useful. -->

## Database changes

<!-- Delete this section if not applicable. -->

- [ ] No database changes
- [ ] Schema migration included
- [ ] Data migration required
- [ ] Migration is backwards compatible
- [ ] Migration has been tested against realistic data

### Migration notes

<!--
Describe schema/data changes and any operational considerations.

Consider:
- Can old and new application versions run against this schema?
- Does this lock a large table?
- Is a backfill required?
- Can the migration be rolled back?
-->

## Configuration / environment changes

<!-- Delete this section if not applicable. -->

- [ ] No configuration changes
- [ ] New environment variables
- [ ] Environment variables removed/renamed
- [ ] Infrastructure/configuration changes required

### Variables / configuration

| Name | Required | Description |
| ---- | -------- | ----------- |
|      |          |             |

## Testing

### How was this tested?

<!--
Describe the important scenarios you tested.
-->

- [ ] Unit tests
- [ ] Integration tests
- [ ] End-to-end tests
- [ ] Manual testing
- [ ] Not applicable

### Test scenarios

<!--
Example:
- Creating a payment succeeds with valid input
- Duplicate requests remain idempotent
- Unauthorized requests return 401
- Failed provider requests are retried correctly
-->

## Failure cases & edge cases

<!--
What happens when things go wrong?

Think about:
- invalid input
- partial failures
- retries
- timeouts
- concurrency
- duplicate requests
- unavailable dependencies
- transaction failures
-->

## Security

- [ ] No security implications
- [ ] Authentication / authorization reviewed
- [ ] User-controlled input is validated
- [ ] No secrets or sensitive information are logged
- [ ] Sensitive data is handled appropriately
- [ ] New dependencies have been reviewed

### Security notes

<!-- Add anything reviewers should pay particular attention to. -->

## Observability

<!-- Delete if not applicable. -->

- [ ] Existing observability is sufficient
- [ ] Logs added/updated
- [ ] Metrics added/updated
- [ ] Tracing added/updated
- [ ] Alerts need to be added/updated

### What should we monitor?

<!--
What signals would tell us this change is working — or breaking?
-->

## Performance

- [ ] No meaningful performance impact
- [ ] Performance impact considered/tested
- [ ] Database query impact reviewed
- [ ] Potential N+1 queries considered
- [ ] Caching implications considered

### Performance notes

<!-- Benchmarks/query plans/etc. where relevant. -->

## Deployment

- [ ] Standard deployment
- [ ] Requires migration before deployment
- [ ] Requires migration after deployment
- [ ] Requires configuration/environment changes
- [ ] Requires coordinated deployment
- [ ] Requires manual steps

### Deployment steps

<!--
1.
2.
3.
-->

## Rollback plan

<!--
If this causes problems in production, how do we safely undo it?

"Revert the PR" is fine when that is genuinely sufficient.
-->

## Breaking changes

- [ ] None

<!--
If there are breaking changes, explain:
- what breaks
- who/what is affected
- migration path
-->

## Reviewer notes

<!--
Point reviewers toward the areas that deserve the most attention.

Example:
"The transaction handling in payment_service.go is the main thing
I'd like reviewed carefully."
-->

## Pre-merge checklist

- [ ] Code follows project conventions
- [ ] Tests added/updated where appropriate
- [ ] Existing tests pass
- [ ] Error handling has been considered
- [ ] Logging does not expose sensitive information
- [ ] API changes are documented
- [ ] Database migrations are safe
- [ ] New environment variables are documented
- [ ] No unnecessary debug code/logging remains
- [ ] Documentation updated where necessary
- [ ] I have reviewed my own diff
