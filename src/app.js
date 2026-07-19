import { createHash } from 'node:crypto';
import express from 'express';
import { apiKeyCacheKey, generateApiKey, hashApiKey } from './api-keys.js';

const API_KEY_PATTERN = /^tsk_[a-f0-9]{64}$/;
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email) ||
    email.split('@')[0].includes('..') ||
    email.split('@')[0].length > 64
  ) {
    return null;
  }
  return email;
}

function retryAfterSeconds(milliseconds) {
  return String(Math.max(1, Math.ceil(milliseconds / 1000)));
}

function stripeId(value) {
  return typeof value === 'string' ? value : value?.id;
}

async function updateCachedTier(redis, row, tier) {
  if (row) {
    await redis.hset(apiKeyCacheKey(row.api_key_hash), 'tier', tier);
  }
}

async function processStripeEvent({ event, client, redis, stripe, priceToTier }) {
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const session = event.data.object;
    if (!['paid', 'no_payment_required'].includes(session.payment_status)) return;
    const customerId = stripeId(session.customer);
    if (!customerId) throw new Error('Checkout session has no customer');

    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    const tier = items.data
      .map((item) => priceToTier.get(item.price?.id))
      .find(Boolean);
    if (!tier) throw new Error('Checkout session has no configured tier price');

    const result = await client.query(
      `UPDATE subscribers
       SET tier = $1, updated_at = NOW()
       WHERE stripe_customer_id = $2
       RETURNING uid, api_key_hash`,
      [tier, customerId],
    );
    if (result.rows.length !== 1) throw new Error('Stripe customer is not registered');
    await updateCachedTier(redis, result.rows[0], tier);
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = stripeId(event.data.object.customer);
    if (!customerId) throw new Error('Subscription has no customer');

    const result = await client.query(
      `UPDATE subscribers
       SET tier = 'FREE', updated_at = NOW()
       WHERE stripe_customer_id = $1
       RETURNING uid, api_key_hash`,
      [customerId],
    );
    if (result.rows.length !== 1) throw new Error('Stripe customer is not registered');
    await updateCachedTier(redis, result.rows[0], 'FREE');
  }
}

export function createApp({
  config,
  pool,
  redis,
  stripe,
  apiRateLimiter,
  registrationRateLimiter,
  logger = console,
}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);

  app.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.get('stripe-signature'),
        config.stripeWebhookSecret,
      );
    } catch {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO billing_events (stripe_event_id, event_type, status)
         VALUES ($1, $2, 'processing')
         ON CONFLICT (stripe_event_id) DO NOTHING
         RETURNING stripe_event_id`,
        [event.id, event.type],
      );

      if (claimed.rows.length === 0) {
        await client.query('COMMIT');
        return res.json({ received: true, duplicate: true });
      }

      await processStripeEvent({
        event,
        client,
        redis,
        stripe,
        priceToTier: config.priceToTier,
      });
      await client.query(
        `UPDATE billing_events
         SET status = 'processed', processed_at = NOW()
         WHERE stripe_event_id = $1`,
        [event.id],
      );
      await client.query('COMMIT');
      return res.json({ received: true });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error('Stripe webhook rollback failed', rollbackError);
        }
      }
      logger.error('Stripe webhook processing failed', {
        eventId: event.id,
        eventType: event.type,
        error,
      });
      return res.status(500).json({ error: 'Webhook processing failed' });
    } finally {
      client?.release();
    }
  });

  app.use(express.json({ limit: '16kb' }));

  app.post('/v1/register', async (req, res) => {
    const ipHash = createHash('sha256').update(req.ip || 'unknown').digest('hex');
    try {
      const rate = await registrationRateLimiter.consume({
        key: `register:${ipHash}`,
        limit: config.registrationRateLimit,
        windowMs: config.registrationRateWindowMs,
      });
      if (!rate.allowed) {
        res.set('Retry-After', retryAfterSeconds(rate.retryAfterMs));
        return res.status(429).json({ error: 'Registration rate limit exceeded' });
      }
    } catch (error) {
      logger.error('Registration rate limiter failed', error);
      return res.status(503).json({ error: 'Registration temporarily unavailable' });
    }

    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'A valid email is required' });

    const { apiKey, hash } = generateApiKey(config.apiKeySecret);
    const cacheKey = apiKeyCacheKey(hash);
    let client;
    let cacheWritten = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO subscribers (api_key_hash, email, tier)
         VALUES ($1, $2, 'FREE')
         RETURNING uid`,
        [hash, email],
      );
      const uid = String(result.rows[0].uid);
      await redis.hset(cacheKey, { uid, tier: 'FREE' });
      cacheWritten = true;
      await client.query('COMMIT');
      return res.status(201).json({
        message: 'Store this key securely; it will not be shown again',
        apiKey,
        uid,
        tier: 'FREE',
      });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error('Registration rollback failed', rollbackError);
        }
      }
      if (cacheWritten) {
        try {
          await redis.del(cacheKey);
        } catch (cleanupError) {
          logger.error('Registration cache cleanup failed', cleanupError);
        }
      }
      if (error?.code === '23505') {
        return res.status(409).json({ error: 'Email is already registered' });
      }
      logger.error('Registration failed', error);
      return res.status(500).json({ error: 'Registration failed' });
    } finally {
      client?.release();
    }
  });

  const authenticate = async (req, res, next) => {
    const apiKey = req.get('x-api-key');
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    if (!API_KEY_PATTERN.test(apiKey)) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    try {
      const hash = hashApiKey(apiKey, config.apiKeySecret);
      const cachedUser = await redis.hgetall(apiKeyCacheKey(hash));

      // PostgreSQL remains authoritative for revocation and tier changes. This
      // also prevents a partial Redis write from creating a usable credential.
      const result = cachedUser?.uid
        ? await pool.query(
            `SELECT uid, tier
             FROM subscribers
             WHERE uid = $1 AND api_key_hash = $2`,
            [cachedUser.uid, hash],
          )
        : await pool.query(
            `SELECT uid, tier
             FROM subscribers
             WHERE api_key_hash = $1`,
            [hash],
          );
      if (result.rows.length !== 1 || !config.tiers[result.rows[0].tier]) {
        return res.status(403).json({ error: 'Invalid API key' });
      }
      const user = { uid: String(result.rows[0].uid), tier: result.rows[0].tier };
      if (!cachedUser?.uid) {
        await redis.hset(apiKeyCacheKey(hash), user);
      }

      const rate = await apiRateLimiter.consume(user);
      if (!rate.allowed) {
        if (rate.reason === 'invalid_tier') {
          return res.status(403).json({ error: 'Invalid API key' });
        }
        if (rate.retryAfterMs) {
          res.set('Retry-After', retryAfterSeconds(rate.retryAfterMs));
        }
        const message =
          rate.reason === 'monthly' ? 'Monthly request limit reached' : 'Rate limit exceeded';
        return res.status(429).json({ error: message });
      }

      req.user = { uid: user.uid, tier: user.tier };
      return next();
    } catch (error) {
      logger.error('API authentication failed', error);
      return res.status(503).json({ error: 'Authentication temporarily unavailable' });
    }
  };

  const unsupported = (capability) => (_req, res) =>
    res.status(501).json({
      error: `${capability} is not implemented`,
      code: 'not_implemented',
    });

  app.post('/v1/generate', authenticate, unsupported('Proof generation'));
  app.post('/v1/verify', authenticate, unsupported('Proof verification'));

  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      version: '1.1.0',
      capabilities: { generation: 'unsupported', verification: 'unsupported' },
    }),
  );

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large' });
    }
    logger.error('Unhandled request error', error);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
