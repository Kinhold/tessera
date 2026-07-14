# Kinhold Tessera

Tessera is the Kinhold API service package intended to host zero-knowledge proof
generation and verification. Those capabilities are not implemented yet:
authenticated calls to `/v1/generate` and `/v1/verify` return HTTP `501` with
`code: "not_implemented"`. The service does not claim that a proof is valid.

The current package provides:

- API-key registration and HMAC-hashed Redis lookups, with PostgreSQL as the
  authoritative credential and tier store
- configurable per-key rate and monthly request limits
- configurable per-IP registration rate limiting
- Stripe webhook signature verification and durable PostgreSQL idempotency
- subscriber tier updates for completed Checkout Sessions and deleted subscriptions

## Requirements

- Node.js 20 or newer
- PostgreSQL
- Redis
- A Stripe restricted key with permission to list Checkout Session line items
- A Stripe webhook signing secret

Copy `.env.example` to `.env` and replace every placeholder. `API_KEY_SECRET`
must be a random secret of at least 32 characters. Keep all secrets in your
deployment platform's secret store; do not commit `.env`.

Install and initialize:

```sh
npm install
npm run db:migrate
npm start
```

For local development, `npm run dev` starts Node's watch mode. The service
validates required configuration before opening the HTTP listener.

## Endpoints

### `POST /v1/register`

Accepts JSON containing a valid `email`. A successful response has status `201`
and returns an API key once. Store it securely:

```json
{ "email": "person@example.com" }
```

Duplicate emails return `409`. Invalid emails return `400`. Registration limits
return `429` with `Retry-After`.

### `POST /v1/generate` and `POST /v1/verify`

Send the issued key in `X-API-Key`. Missing, invalid, and rate-limited keys return
`401`, `403`, and `429`, respectively. Valid requests currently return `501`;
there is no proof generator or verifier in this repository.

### `POST /webhook`

Configure Stripe to send events to this route. The raw request body is verified
using `STRIPE_WEBHOOK_SECRET`. Event IDs are claimed in `billing_events` inside
the same PostgreSQL transaction as subscriber changes. Duplicate events are
acknowledged without being processed again. Processing or database failures
return `500` so Stripe retries them; invalid signatures return `400`.

Handled billing events:

- `checkout.session.completed` (paid sessions only)
- `checkout.session.async_payment_succeeded`
- `customer.subscription.deleted`

Other valid event types are safely recorded and acknowledged without changing a
subscriber.

### `GET /health`

Returns process health and explicitly reports generation and verification as
unsupported.

## Configuration

All required values and rate-control defaults are documented in `.env.example`.
`TRUST_PROXY_HOPS` must match the number of trusted reverse proxies in front of
the service so registration limits use the correct client address.

Plan defaults:

| Tier | Monthly requests | Minimum interval |
| --- | ---: | ---: |
| FREE | 100 | 60 seconds |
| PRO | 5,000 | 3 seconds |
| WHALE | unlimited | none |

Run checks with:

```sh
npm test
npm run check
```
