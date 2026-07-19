import { createHmac, randomBytes } from 'node:crypto';

export function hashApiKey(apiKey, secret) {
  return createHmac('sha256', secret).update(apiKey).digest('hex');
}

export function generateApiKey(secret) {
  const apiKey = `tsk_${randomBytes(32).toString('hex')}`;
  return { apiKey, hash: hashApiKey(apiKey, secret) };
}

export function apiKeyCacheKey(hash) {
  return `apikey:${hash}`;
}
