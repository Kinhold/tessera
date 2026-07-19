BEGIN;

CREATE TABLE IF NOT EXISTS subscribers (
  uid BIGSERIAL PRIMARY KEY,
  api_key_hash CHAR(64) NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'FREE'
    CHECK (tier IN ('FREE', 'PRO', 'WHALE')),
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (email = LOWER(email)),
  CHECK (length(email) BETWEEN 3 AND 254)
);

CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('processing', 'processed')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

COMMIT;
