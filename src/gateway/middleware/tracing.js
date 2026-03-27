'use strict';

const { v4: uuidv4 } = require('uuid');

const DEFAULT_THREAD_HEADER = 'ah-thread-id';
const DEFAULT_TRACE_HEADER = 'ah-trace-id';

function tracingMiddleware(req, res, next) {
  req.traceId = req.headers[DEFAULT_TRACE_HEADER] || uuidv4();
  req.threadId = req.headers[DEFAULT_THREAD_HEADER] || null;

  const codexSessionId = req.headers['x-session-id'] || req.headers['session-id'];
  if (codexSessionId && !req.threadId) {
    req.threadId = codexSessionId;
  }

  res.setHeader('X-Request-Id', req.traceId);
  req.startTime = Date.now();

  next();
}

module.exports = { tracingMiddleware };
