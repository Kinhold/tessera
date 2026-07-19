const API_LIMIT_SCRIPT = `
local monthlyLimit = tonumber(ARGV[1])
local rateWindowMs = tonumber(ARGV[2])
local usageTtlSeconds = tonumber(ARGV[3])

if monthlyLimit >= 0 then
  local volume = tonumber(redis.call('GET', KEYS[2]) or '0')
  if volume >= monthlyLimit then
    return {0, 2, 0}
  end
end

if rateWindowMs > 0 then
  local accepted = redis.call('SET', KEYS[1], '1', 'PX', rateWindowMs, 'NX')
  if not accepted then
    return {0, 1, redis.call('PTTL', KEYS[1])}
  end
end

if monthlyLimit >= 0 then
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], usageTtlSeconds)
end

return {1, 0, 0}
`;

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
if count > tonumber(ARGV[1]) then
  return {0, ttl}
end
return {1, ttl}
`;

function monthKey(now) {
  return now.toISOString().slice(0, 7);
}

export function createApiRateLimiter(redis, tiers, now = () => new Date()) {
  return {
    async consume({ uid, tier }) {
      const limits = tiers[tier];
      if (!limits) return { allowed: false, reason: 'invalid_tier' };

      const result = await redis.eval(
        API_LIMIT_SCRIPT,
        2,
        `rate:${uid}`,
        `usage:${uid}:${monthKey(now())}`,
        limits.monthlyLimit ?? -1,
        limits.rateWindowMs,
        60 * 60 * 24 * 35,
      );

      const allowed = Number(result[0]) === 1;
      const reasonCode = Number(result[1]);
      return {
        allowed,
        reason: reasonCode === 1 ? 'rate' : reasonCode === 2 ? 'monthly' : undefined,
        retryAfterMs: Math.max(0, Number(result[2]) || 0),
      };
    },
  };
}

export function createFixedWindowRateLimiter(redis) {
  return {
    async consume({ key, limit, windowMs }) {
      const result = await redis.eval(FIXED_WINDOW_SCRIPT, 1, key, limit, windowMs);
      return {
        allowed: Number(result[0]) === 1,
        retryAfterMs: Math.max(0, Number(result[1]) || 0),
      };
    },
  };
}
