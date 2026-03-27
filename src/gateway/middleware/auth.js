'use strict';

const { getDb } = require('../db');

function extractApiKey(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.headers['x-api-key'] || req.query.api_key || null;
}

function apiKeyAuth(req, res, next) {
  const key = extractApiKey(req);
  if (!key) {
    return res.status(401).json({
      error: { message: 'Missing API key. Provide via Authorization: Bearer <key> or X-API-Key header.', type: 'authentication_error', code: 'missing_api_key' }
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

module.exports = { apiKeyAuth, optionalAuth, adminAuth, extractApiKey };
