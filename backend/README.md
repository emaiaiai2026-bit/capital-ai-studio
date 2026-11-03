# Capital AI Studio — Provider-neutral job lifecycle

This backend stores and reads video job records without depending on a specific generation provider.

## Routes
- `GET /api/health` — health check.
- `GET /api/providers` — currently returns an empty provider list.
- `POST /api/jobs` — validates the request and saves a **draft** job only.
- `GET /api/jobs/:id` — returns the persisted job and its event history.
- `POST /api/jobs/submit` — deliberately returns `409 GENERATION_DISABLED`.

## Job lifecycle
The durable store uses a SQLite-backed Cloudflare Durable Object per job.
- `draft → queued → processing → completed`
- A job may transition to `failed` or `cancelled` where appropriate.
- Terminal states cannot be reopened.
- Every transition is recorded in `job_events` with a timestamp.
- The provider-neutral fields are `providerId` and `providerJobId`; they remain null until an adapter is configured.

## Current safety state
- Saving a draft does not contact any provider.
- No provider adapter is registered.
- Submission is disabled.
- No credentials or provider URLs are stored in source.
- Nothing has been deployed.

## Important before deployment
These routes are a development foundation, not production-ready public endpoints. Add user authentication/authorization, ownership checks, request rate limits, retention policy, and operational monitoring before exposing job records on the internet. The current GET route uses an opaque UUID but UUIDs are not authorization. Do not deploy this branch as-is.

## Next
Add authenticated ownership and a user-scoped job listing, then implement provider adapter submission and polling behind the shared lifecycle contract.
