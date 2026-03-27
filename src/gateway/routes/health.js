'use strict';

const { Router } = require('express');
const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'windsurf-gateway', timestamp: new Date().toISOString() });
});

router.get('/version', (req, res) => {
  const { getDb } = require('../db');
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM systems WHERE key = 'system_version'").get();
    res.json({ version: row ? row.value : '1.0.0' });
  } catch {
    res.json({ version: '1.0.0' });
  }
});

module.exports = router;
