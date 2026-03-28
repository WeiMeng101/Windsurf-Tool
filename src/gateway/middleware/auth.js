'use strict';

const { getDb } = require('../db');

// ---- In-memory per-key rate limiter ----

/** @type {Map<string, { count: number, resetTime: number }>} */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;   // 1-minute sliding window
const RATE_LIMIT_MAX_REQUESTS = 60;    // max requests per key per window

/**
 * Prune expired entries from the rate limit map.
 * Runs lazily -- called on every rateLimit() invocation so the map
 * never grows unbounded even without a background timer.
 */
function _pruneRateLimits() {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}

/**
 * Express middleware: per-API-key rate limiter.
 * Must be placed AFTER apiKeyAuth so that `req.apiKey` is populated.
 *
 * Returns 429 with Retry-After header when the limit is exceeded.
 */
function rateLimit(req, res, next) {
  const keyId = req.apiKey?.key || req.apiKey?.id;
  if (!keyId) return next(); // no key -- nothing to rate-limit

  _pruneRateLimits();

  const now = Date.now();
  let entry = rateLimitMap.get(keyId);

  if (!entry || now >= entry.resetTime) {
    entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(keyId, entry);
  }

  entry.count += 1;

  // Expose standard rate-limit headers
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - entry.count);
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((entry.resetTime - now) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({
      error: {
        message: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    });
  }

  next();
}

function extractApiKey(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.headers['x-api-key'] || req.query.api_key || null;
}

// ---- Brute-force protection: per-IP invalid key tracking ----
const invalidKeyAttempts = new Map();
const BRUTE_FORCE_WINDOW_MS = 60_000;
const BRUTE_FORCE_MAX_FAILURES = 10;

function _checkBruteForce(ip) {
  const now = Date.now();
  const entry = invalidKeyAttempts.get(ip);
  if (!entry || now >= entry.resetTime) return false;
  return entry.count >= BRUTE_FORCE_MAX_FAILURES;
}

function _recordInvalidKey(ip) {
  const now = Date.now();
  const entry = invalidKeyAttempts.get(ip);
  if (!entry || now >= entry.resetTime) {
    invalidKeyAttempts.set(ip, { count: 1, resetTime: now + BRUTE_FORCE_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function apiKeyAuth(req, res, next) {
  const key = extractApiKey(req);
  if (!key) {
    return res.status(401).json({
      error: { message: 'Missing API key. Provide via Authorization: Bearer <key> or X-API-Key header.', type: 'authentication_error', code: 'missing_api_key' }
    });
  }

  // Brute-force protection: block IPs with too many invalid keys
  const clientIp = req.ip || req.connection?.remoteAddress || '';
  if (_checkBruteForce(clientIp)) {
    return res.status(429).json({
      error: { message: 'Too many invalid key attempts. Try again later.', type: 'rate_limit_error', code: 'brute_force_blocked' }
    });
  }

  try {
    const db = getDb();
    const apiKey = db.prepare(`
      SELECT ak.*, u.role as user_role, u.status as user_status
      FROM api_keys ak
      LEFT JOIN users u ON ak.user_id = u.id
      WHERE ak.key = ? AND ak.status = 'enabled' AND ak.deleted_at IS NULL
    `).get(key);

    if (!apiKey) {
      _recordInvalidKey(clientIp);
      return res.status(401).json({
        error: { message: 'Invalid or disabled API key.', type: 'authentication_error', code: 'invalid_api_key' }
      });
    }

    if (apiKey.user_status === 'disabled') {
      return res.status(403).json({
        error: { message: 'User account is disabled.', type: 'authorization_error', code: 'user_disabled' }
      });
    }

    req.apiKey = apiKey;
    req.projectId = apiKey.project_id;
    next();
  } catch (err) {
    return res.status(500).json({
      error: { message: 'Internal authentication error.', type: 'server_error', code: 'auth_error' }
    });
  }
}

function optionalAuth(req, res, next) {
  const key = extractApiKey(req);
  if (key) {
    return apiKeyAuth(req, res, next);
  }
  req.apiKey = null;
  req.projectId = 1;
  next();
}

function adminAuth(req, res, next) {
  if (!req.apiKey || !['owner', 'admin'].includes(req.apiKey.user_role)) {
    return res.status(403).json({
      error: { message: 'Admin access required.', type: 'authorization_error', code: 'insufficient_permissions' }
    });
  }
  next();
}

module.exports = { apiKeyAuth, optionalAuth, adminAuth, extractApiKey, rateLimit };
