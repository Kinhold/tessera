const REQUIRED_ENV = [
  'DATABASE_URL',
  'REDIS_URL',
  'API_KEY_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_WHALE',
];

function readInteger(env, name, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readUrl(env, name, protocols) {
  let value;
  try {
    value = new URL(env[name]);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(value.protocol)) {
    throw new Error(`${name} must use one of: ${protocols.join(', ')}`);
  }
  return value.toString();
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (env.API_KEY_SECRET.length < 32) {
    throw new Error('API_KEY_SECRET must be at least 32 characters');
  }
  if (env.STRIPE_PRICE_PRO === env.STRIPE_PRICE_WHALE) {
    throw new Error('STRIPE_PRICE_PRO and STRIPE_PRICE_WHALE must be different');
  }
  if (!/^(rk|sk)_(test|live)_/.test(env.STRIPE_SECRET_KEY)) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe server-side key');
  }
  if (!env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
    throw new Error('STRIPE_WEBHOOK_SECRET must start with whsec_');
  }
  if (![env.STRIPE_PRICE_PRO, env.STRIPE_PRICE_WHALE].every((value) => value.startsWith('price_'))) {
    throw new Error('Stripe price IDs must start with price_');
  }

  return {
    port: readInteger(env, 'PORT', 3000, { min: 1, max: 65535 }),
    databaseUrl: readUrl(env, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: readUrl(env, 'REDIS_URL', ['redis:', 'rediss:']),
    apiKeySecret: env.API_KEY_SECRET,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceToTier: new Map([
      [env.STRIPE_PRICE_PRO, 'PRO'],
      [env.STRIPE_PRICE_WHALE, 'WHALE'],
    ]),
    trustProxyHops: readInteger(env, 'TRUST_PROXY_HOPS', 0, { min: 0, max: 10 }),
    registrationRateLimit: readInteger(env, 'REGISTER_RATE_LIMIT', 5, { min: 1 }),
    registrationRateWindowMs: readInteger(
      env,
      'REGISTER_RATE_WINDOW_MS',
      60 * 60 * 1000,
      { min: 1000 },
    ),
    tiers: {
      FREE: {
        monthlyLimit: readInteger(env, 'FREE_MONTHLY_LIMIT', 100, { min: 1 }),
        rateWindowMs: readInteger(env, 'FREE_RATE_WINDOW_MS', 60_000, { min: 0 }),
      },
      PRO: {
        monthlyLimit: readInteger(env, 'PRO_MONTHLY_LIMIT', 5000, { min: 1 }),
        rateWindowMs: readInteger(env, 'PRO_RATE_WINDOW_MS', 3000, { min: 0 }),
      },
      WHALE: {
        monthlyLimit: null,
        rateWindowMs: readInteger(env, 'WHALE_RATE_WINDOW_MS', 0, { min: 0 }),
      },
    },
  };
}
