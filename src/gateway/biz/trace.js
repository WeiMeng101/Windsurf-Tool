'use strict';

const { getDb } = require('../db');
const logger = require('../logger');

class TraceService {
  findOrCreateTrace(projectId, externalTraceId, name) {
    const db = getDb();
    if (externalTraceId) {
      const existing = db.prepare('SELECT * FROM traces WHERE external_trace_id = ? AND project_id = ?').get(externalTraceId, projectId);
      if (existing) return existing;
    }

    const result = db.prepare(`
      INSERT INTO traces (project_id, external_trace_id, name, status)
      VALUES (?, ?, ?, 'active')
    `).run(projectId, externalTraceId || '', name || '');

    return db.prepare('SELECT * FROM traces WHERE id = ?').get(result.lastInsertRowid);
  }

  findOrCreateThread(projectId, externalThreadId, name) {
    const db = getDb();
    if (externalThreadId) {
      const existing = db.prepare('SELECT * FROM threads WHERE external_thread_id = ? AND project_id = ?').get(externalThreadId, projectId);
      if (existing) return existing;
    }

    const result = db.prepare(`
      INSERT INTO threads (project_id, external_thread_id, name)
      VALUES (?, ?, ?)
    `).run(projectId, externalThreadId || '', name || '');

    return db.prepare('SELECT * FROM threads WHERE id = ?').get(result.lastInsertRowid);
  }

  linkTraceToThread(traceId, threadId) {
    const db = getDb();
    db.prepare('UPDATE traces SET thread_id = ? WHERE id = ? AND thread_id IS NULL').run(threadId, traceId);
  }

  getTraceWithRequests(traceId) {
    const db = getDb();
    const trace = db.prepare('SELECT * FROM traces WHERE id = ?').get(traceId);
    if (!trace) return null;

    const requests = db.prepare(`
      SELECT r.*, c.name as channel_name, c.type as channel_type
      FROM requests r
      LEFT JOIN channels c ON r.channel_id = c.id
      WHERE r.trace_id = ?
      ORDER BY r.created_at ASC
    `).all(traceId);

    return { ...trace, requests };
  }

  getThreadWithTraces(threadId) {
    const db = getDb();
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
    if (!thread) return null;

    const traces = db.prepare(`
      SELECT t.*, COUNT(r.id) as request_count
      FROM traces t
      LEFT JOIN requests r ON r.trace_id = t.id
      WHERE t.thread_id = ?
      GROUP BY t.id
      ORDER BY t.created_at ASC
    `).all(threadId);

    return { ...thread, traces };
  }

  completeTrace(traceId, status) {
    const db = getDb();
    db.prepare("UPDATE traces SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status || 'completed', traceId);
  }
}

const traceService = new TraceService();

module.exports = { TraceService, traceService };
