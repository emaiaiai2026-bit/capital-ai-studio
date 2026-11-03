# Capital AI Studio — Provider Adapter Foundation

This backend foundation separates the app API from any video provider.

## Current routes
- `GET /api/health` — health response.
- `GET /api/providers` — lists registered adapters (currently none).
- `POST /api/jobs` — deliberately returns `503 PROVIDER_NOT_CONFIGURED`.

## Adapter contract
Every future adapter must expose:
- `id`: stable provider identifier.
- `getCapabilities()`: supported generation modes.
- `createJob(input)`: submit a provider job.
- `getJob(providerJobId)`: retrieve provider job status/result.

Provider statuses are normalized to: `queued`, `processing`, `completed`, `failed`, or `unknown`.

## Safety state
- No provider is registered.
- No provider URL or credential is present.
- No generation request can be submitted.
- No deployment has been performed.
- Do not add API keys to source control. Cloudflare documents encrypted Worker secrets and recommends keeping secrets out of Wrangler configuration and source files.

## Next implementation phase
After choosing a provider and confirming its official API access, implement one adapter behind this contract, add authenticated job persistence and polling/webhooks, then connect the UI. Keep each provider isolated so another adapter can be added without changing the app-wide job format.
