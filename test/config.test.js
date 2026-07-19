import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

function validEnv() {
  return {
    DATABASE_URL: 'postgresql://localhost/tessera',
    REDIS_URL: 'redis://localhost:6379',
    API_KEY_SECRET: 'a-secret-value-that-is-longer-than-32-characters',
    STRIPE_SECRET_KEY: 'rk_test_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_WHALE: 'price_whale',
  };
}

test('configuration reports all missing required variables', () => {
  assert.throws(
    () => loadConfig({}),
    /DATABASE_URL, REDIS_URL, API_KEY_SECRET, STRIPE_SECRET_KEY/,
  );
});

test('configuration rejects weak API key hashing secrets', () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), API_KEY_SECRET: 'too-short' }),
    /at least 32 characters/,
  );
});

test('configuration parses rate controls', () => {
  const config = loadConfig({
    ...validEnv(),
    REGISTER_RATE_LIMIT: '9',
    FREE_MONTHLY_LIMIT: '250',
  });
  assert.equal(config.registrationRateLimit, 9);
  assert.equal(config.tiers.FREE.monthlyLimit, 250);
});
