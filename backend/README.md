# Capital AI Studio — Google sign-in and job lifecycle

## Authentication routes
- `GET /auth/google/start` — begins Google OpenID Connect authorization-code flow with state, nonce, and PKCE.
- `GET /auth/google/callback` — exchanges the code, verifies Google's RS256 ID-token signature using Google's JWKS, checks issuer/audience/expiry/nonce/email verification, then issues a signed Secure, HttpOnly, SameSite=Lax session cookie.
- `GET /api/me` — returns the signed-in user or 401.
- `POST /auth/logout` — clears the session cookie.

The session cookie is signed with HMAC-SHA-256 and expires after seven days. The backend does not accept a user ID or email supplied by the browser as proof of identity.

## Required runtime configuration
Set these as Worker environment variables/secrets; never commit their values:
- `APP_ORIGIN` — exact public HTTPS origin of the deployed frontend/backend, e.g. `https://your-real-domain.example` (replace with the actual domain).
- `GOOGLE_CLIENT_ID` — OAuth client ID from Google Cloud.
- `GOOGLE_CLIENT_SECRET` — OAuth client secret; store as a Cloudflare secret.
- `SESSION_SECRET` — long random secret (at least 32 random bytes); store as a Cloudflare secret.

Google OAuth authorized redirect URI must exactly equal:
`https://YOUR-REAL-DOMAIN/auth/google/callback`

Do not create Google credentials until the final public domain is confirmed. Do not paste secrets into chat or GitHub.

## Job API
- `GET /api/health` — health check.
- `GET /api/providers` — currently returns an empty provider list.
- `POST /api/jobs` — requires a valid session and saves a draft only.
- `GET /api/jobs/:id` — requires a valid session and returns a job only when its stored owner matches the signed-in Google subject.
- `POST /api/jobs/submit` — deliberately returns `409 GENERATION_DISABLED`.

The Durable Object stores the immutable Google subject in `owner_id`; an additive schema migration supports existing databases. Existing pre-authentication jobs have no owner and are not exposed through the authenticated API.

## Lifecycle
- `draft → queued → processing → completed`
- A job may transition to `failed` or `cancelled` where appropriate.
- Terminal states cannot be reopened.
- Every transition is recorded in `job_events`.

## Security and deployment status
- Google identity is verified server-side; ID tokens are not trusted merely because the browser sends them.
- OAuth state, nonce, and PKCE are used.
- Provider registry is empty; no generation provider is called.
- Submission remains disabled.
- No secrets have been added and nothing has been deployed.
- A per-user job-history endpoint/index is still pending.
- Before production, add rate limiting, session revocation strategy, CSRF protections for state-changing routes, monitoring, and retention policy; test OAuth against the final HTTPS origin.

This branch is an implementation draft and has not been runtime-tested or deployed. Do not deploy until the OAuth configuration and security review are complete.


## Local automated tests

The backend test harness uses Vitest with Cloudflare's Workers pool so tests execute in the Workers runtime with a local Miniflare-backed Durable Object binding.

From the `backend/` directory:

```sh
npm install
npm test
```

Test coverage currently includes:
- Draft creation and initial event history.
- Durable Object persistence across calls.
- Valid lifecycle transition and event recording.
- Transaction rollback when event serialization fails after the row update.
- Rejection of invalid lifecycle transitions without history changes.
- Isolation between distinct Durable Object identities.
- Missing-job lookup.

The rollback test intentionally causes JSON serialization to throw after the SQL update has run inside `transactionSync`; the expected result is that the transaction restores the prior status and event count.

**Execution status:** the test files and configuration are committed, but the suite has not yet been executed in this environment. A successful GitHub file write is not evidence that dependencies install or tests pass. Do not merge until `npm install` and `npm test` complete successfully in the backend directory and their output is reviewed.
