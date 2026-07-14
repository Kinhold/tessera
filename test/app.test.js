import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { apiKeyCacheKey, hashApiKey } from '../src/api-keys.js';

const API_KEY_SECRET = 'test-secret-that-is-at-least-32-characters';
const VALID_API_KEY = `tsk_${'a'.repeat(64)}`;

function baseConfig() {
  return {
    apiKeySecret: API_KEY_SECRET,
    stripeWebhookSecret: 'whsec_test',
    priceToTier: new Map([
      ['price_pro', 'PRO'],
      ['price_whale', 'WHALE'],
    ]),
    trustProxyHops: 0,
    registrationRateLimit: 5,
    registrationRateWindowMs: 60_000,
    tiers: {
      FREE: { monthlyLimit: 100, rateWindowMs: 1000 },
      PRO: { monthlyLimit: 5000, rateWindowMs: 100 },
      WHALE: { monthlyLimit: null, rateWindowMs: 0 },
    },
  };
}

function quietLogger() {
  return { error() {} };
}

function makeRedis(users = new Map()) {
  return {
    lookupKeys: [],
    writes: [],
    async hgetall(key) {
      this.lookupKeys.push(key);
      return users.get(key) ?? {};
    },
    async hset(key, ...values) {
      this.writes.push([key, ...values]);
    },
    async del() {},
  };
}

function makeApp(overrides = {}) {
  return createApp({
    config: baseConfig(),
    pool: {
      async query(_text, params) {
        const expectedHash = hashApiKey(VALID_API_KEY, API_KEY_SECRET);
        return params.at(-1) === expectedHash
          ? { rows: [{ uid: '7', tier: 'FREE' }] }
          : { rows: [] };
      },
      async connect() {
        throw new Error('Unexpected database connection');
      },
    },
    redis: makeRedis(),
    stripe: {
      webhooks: { constructEvent() { throw new Error('Invalid signature'); } },
      checkout: { sessions: { async listLineItems() { return { data: [] }; } } },
    },
    apiRateLimiter: { async consume() { return { allowed: true }; } },
    registrationRateLimiter: { async consume() { return { allowed: true }; } },
    logger: quietLogger(),
    ...overrides,
  });
}

async function withServer(app, callback) {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('protected endpoints require an API key', async () => {
  await withServer(makeApp(), async (url) => {
    const response = await fetch(`${url}/v1/verify`, { method: 'POST' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'API key required' });
  });
});

test('unknown API keys are rejected', async () => {
  await withServer(makeApp(), async (url) => {
    const response = await fetch(`${url}/v1/verify`, {
      method: 'POST',
      headers: { 'x-api-key': `tsk_${'b'.repeat(64)}` },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Invalid API key' });
  });
});

test('authentication looks up only the HMAC-hashed API key', async () => {
  const hash = hashApiKey(VALID_API_KEY, API_KEY_SECRET);
  const redis = makeRedis(new Map([[apiKeyCacheKey(hash), { uid: '7', tier: 'FREE' }]]));

  await withServer(makeApp({ redis }), async (url) => {
    const response = await fetch(`${url}/v1/verify`, {
      method: 'POST',
      headers: { 'x-api-key': VALID_API_KEY },
    });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, 'not_implemented');
  });

  assert.deepEqual(redis.lookupKeys, [apiKeyCacheKey(hash)]);
  assert.equal(redis.lookupKeys[0].includes(VALID_API_KEY), false);
});

test('authentication restores a missing hashed Redis cache entry from PostgreSQL', async () => {
  const hash = hashApiKey(VALID_API_KEY, API_KEY_SECRET);
  const redis = makeRedis();

  await withServer(makeApp({ redis }), async (url) => {
    const response = await fetch(`${url}/v1/verify`, {
      method: 'POST',
      headers: { 'x-api-key': VALID_API_KEY },
    });
    assert.equal(response.status, 501);
  });

  assert.equal(redis.writes[0][0], apiKeyCacheKey(hash));
  assert.equal(redis.writes[0][0].includes(VALID_API_KEY), false);
});

test('API rate limits reject requests with retry guidance', async () => {
  const hash = hashApiKey(VALID_API_KEY, API_KEY_SECRET);
  const redis = makeRedis(new Map([[apiKeyCacheKey(hash), { uid: '7', tier: 'FREE' }]]));
  let requests = 0;
  const apiRateLimiter = {
    async consume() {
      requests += 1;
      return requests === 1
        ? { allowed: true }
        : { allowed: false, reason: 'rate', retryAfterMs: 1500 };
    },
  };

  await withServer(makeApp({ redis, apiRateLimiter }), async (url) => {
    const first = await fetch(`${url}/v1/verify`, {
      method: 'POST',
      headers: { 'x-api-key': VALID_API_KEY },
    });
    assert.equal(first.status, 501);

    const second = await fetch(`${url}/v1/verify`, {
      method: 'POST',
      headers: { 'x-api-key': VALID_API_KEY },
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '2');
  });
});

test('generation and verification report unsupported capability', async () => {
  const hash = hashApiKey(VALID_API_KEY, API_KEY_SECRET);
  const redis = makeRedis(new Map([[apiKeyCacheKey(hash), { uid: '7', tier: 'WHALE' }]]));

  await withServer(makeApp({ redis }), async (url) => {
    for (const route of ['generate', 'verify']) {
      const response = await fetch(`${url}/v1/${route}`, {
        method: 'POST',
        headers: { 'x-api-key': VALID_API_KEY },
      });
      assert.equal(response.status, 501);
      assert.equal((await response.json()).code, 'not_implemented');
    }
  });
});

test('registration validates email and enforces its rate limit', async () => {
  let attempts = 0;
  const registrationRateLimiter = {
    async consume() {
      attempts += 1;
      return attempts === 1
        ? { allowed: true }
        : { allowed: false, retryAfterMs: 60_000 };
    },
  };

  await withServer(makeApp({ registrationRateLimiter }), async (url) => {
    const invalid = await fetch(`${url}/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(invalid.status, 400);

    const limited = await fetch(`${url}/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
  });
});

test('registration stores only an API key hash in Redis and PostgreSQL', async () => {
  const queries = [];
  const client = {
    async query(text, params) {
      queries.push([text, params]);
      if (text.includes('INSERT INTO subscribers')) return { rows: [{ uid: 42 }] };
      return { rows: [] };
    },
    release() {},
  };
  const redis = makeRedis();

  await withServer(
    makeApp({ pool: { async connect() { return client; } }, redis }),
    async (url) => {
      const response = await fetch(`${url}/v1/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ' User@Example.COM ' }),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.match(body.apiKey, /^tsk_[a-f0-9]{64}$/);

      const insert = queries.find(([text]) => text.includes('INSERT INTO subscribers'));
      assert.equal(insert[1][1], 'user@example.com');
      assert.equal(insert[1][0], hashApiKey(body.apiKey, API_KEY_SECRET));
      assert.equal(redis.writes[0][0], apiKeyCacheKey(insert[1][0]));
      assert.equal(redis.writes[0][0].includes(body.apiKey), false);
    },
  );
});

test('webhook database failures return 500 so Stripe can retry', async () => {
  let rolledBack = false;
  let released = false;
  const client = {
    async query(text) {
      if (text === 'BEGIN') return { rows: [] };
      if (text === 'ROLLBACK') {
        rolledBack = true;
        return { rows: [] };
      }
      throw new Error('database unavailable');
    },
    release() {
      released = true;
    },
  };
  const stripe = {
    webhooks: {
      constructEvent() {
        return { id: 'evt_failure', type: 'invoice.paid', data: { object: {} } };
      },
    },
    checkout: { sessions: {} },
  };

  await withServer(
    makeApp({ pool: { async connect() { return client; } }, stripe }),
    async (url) => {
      const response = await fetch(`${url}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid-test-signature',
        },
        body: '{}',
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Webhook processing failed' });
    },
  );

  assert.equal(rolledBack, true);
  assert.equal(released, true);
});

test('invalid webhook signatures are rejected before database access', async () => {
  await withServer(makeApp(), async (url) => {
    const response = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid-test-signature',
      },
      body: '{}',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid webhook signature' });
  });
});

test('already-claimed Stripe events are acknowledged as duplicates', async () => {
  const client = {
    async query(text) {
      if (text.includes('INSERT INTO billing_events')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const stripe = {
    webhooks: {
      constructEvent() {
        return { id: 'evt_duplicate', type: 'invoice.paid', data: { object: {} } };
      },
    },
    checkout: { sessions: {} },
  };

  await withServer(
    makeApp({ pool: { async connect() { return client; } }, stripe }),
    async (url) => {
      const response = await fetch(`${url}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid-test-signature',
        },
        body: '{}',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { received: true, duplicate: true });
    },
  );
});
