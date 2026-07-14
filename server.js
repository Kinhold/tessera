import 'dotenv/config';
import Redis from 'ioredis';
import pg from 'pg';
import Stripe from 'stripe';
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { createApiRateLimiter, createFixedWindowRateLimiter } from './src/rate-limit.js';

const serviceConfig = loadConfig();
const redis = new Redis(serviceConfig.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
const pool = new pg.Pool({ connectionString: serviceConfig.databaseUrl });
const stripe = new Stripe(serviceConfig.stripeSecretKey, {
  apiVersion: '2026-06-24.dahlia',
});

const app = createApp({
  config: serviceConfig,
  pool,
  redis,
  stripe,
  apiRateLimiter: createApiRateLimiter(redis, serviceConfig.tiers),
  registrationRateLimiter: createFixedWindowRateLimiter(redis),
});

const server = app.listen(serviceConfig.port, () => {
  console.log(`Tessera listening on port ${serviceConfig.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
