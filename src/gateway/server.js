'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('./logger');
const { getDb, closeDb } = require('./db');
const { cacheManager } = require('./cache');
const { tracingMiddleware } = require('./middleware/tracing');
const { apiKeyAuth, optionalAuth, rateLimit } = require('./middleware/auth');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');

const DEFAULT_PORT = 8090;

class GatewayServer {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_PORT;
    this.app = express();
    this.server = null;
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    this.app.use(helmet({ contentSecurityPolicy: false }));
    this.app.use(cors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Project-ID', 'AH-Thread-Id', 'AH-Trace-Id'],
    }));
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(tracingMiddleware);

    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        if (!req.path.includes('/health')) {
          logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
        }
      });
      next();
    });
  }

  setupRoutes() {
    this.app.use('/', healthRoutes);

    // Admin API (management)
    this.app.use('/api/admin', adminRoutes);

    // OpenAI-compatible API (auth + rate limit)
    this.app.post('/v1/chat/completions', apiKeyAuth, rateLimit, (req, res) => this.handleChatCompletions(req, res));
    this.app.post('/v1/responses', apiKeyAuth, rateLimit, (req, res) => this.handleResponses(req, res));
    this.app.get('/v1/models', optionalAuth, (req, res) => this.handleListModels(req, res));
    this.app.post('/v1/embeddings', apiKeyAuth, rateLimit, (req, res) => this.handleEmbeddings(req, res));
    this.app.post('/v1/images/generations', apiKeyAuth, rateLimit, (req, res) => this.handleImageGeneration(req, res));

    // Anthropic-compatible API
    this.app.post('/v1/messages', apiKeyAuth, rateLimit, (req, res) => this.handleAnthropicMessages(req, res));

    // Gemini-compatible API
    this.app.post('/v1beta/models/:model\\:generateContent', apiKeyAuth, rateLimit, (req, res) => this.handleGeminiGenerate(req, res));
    this.app.post('/v1beta/models/:model\\:streamGenerateContent', apiKeyAuth, rateLimit, (req, res) => this.handleGeminiStream(req, res));
  }

  setupErrorHandling() {
    this.app.use((req, res) => {
      res.status(404).json({
        error: { message: `Route ${req.method} ${req.path} not found`, type: 'not_found', code: 'route_not_found' }
      });
    });

    this.app.use((err, req, res, _next) => {
      logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
      res.status(500).json({
        error: { message: 'Internal server error', type: 'server_error', code: 'internal_error' }
      });
    });
  }

  // ===== LLM API Handlers (delegated to pipeline) =====

  async handleChatCompletions(req, res) {
    try {
      const pipeline = this.getPipeline();
      await pipeline.execute(req, res, 'openai/chat_completions');
    } catch (err) {
      logger.error('Chat completions error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
    }
  }

  async handleResponses(req, res) {
    try {
      const pipeline = this.getPipeline();
      await pipeline.execute(req, res, 'openai/responses');
    } catch (err) {
      logger.error('Responses error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
    }
  }

  async handleAnthropicMessages(req, res) {
    try {
      const pipeline = this.getPipeline();
      await pipeline.execute(req, res, 'anthropic/messages');
    } catch (err) {
      logger.error('Anthropic messages error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
    }
  }

  async handleGeminiGenerate(req, res) {
    try {
      const pipeline = this.getPipeline();
      req.body._gemini_model = req.params.model;
      await pipeline.execute(req, res, 'gemini/generateContent');
    } catch (err) {
      logger.error('Gemini generate error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
    }
  }

  async handleGeminiStream(req, res) {
    try {
      const pipeline = this.getPipeline();
      req.body._gemini_model = req.params.model;
      req.body.stream = true;
      await pipeline.execute(req, res, 'gemini/streamGenerateContent');
    } catch (err) {
      logger.error('Gemini stream error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
    }
  }

  handleListModels(req, res) {
    const db = getDb();
    const channels = db.prepare("SELECT supported_models, manual_models FROM channels WHERE status = 'enabled' AND deleted_at IS NULL").all();
    const modelSet = new Set();
    channels.forEach(ch => {
      JSON.parse(ch.supported_models || '[]').forEach(m => modelSet.add(m));
      JSON.parse(ch.manual_models || '[]').forEach(m => modelSet.add(m));
    });
    const dbModels = db.prepare("SELECT model_id FROM models WHERE status = 'enabled' AND deleted_at IS NULL").all();
    dbModels.forEach(m => modelSet.add(m.model_id));

    const models = Array.from(modelSet).sort().map(id => ({
      id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'gateway',
    }));
    res.json({ object: 'list', data: models });
  }

  async handleEmbeddings(req, res) {
    try {
      const pipeline = this.getPipeline();
      await pipeline.execute(req, res, 'openai/embeddings');
    } catch (err) {
      logger.error('Embeddings error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
    }
  }

  async handleImageGeneration(req, res) {
    try {
      const pipeline = this.getPipeline();
      await pipeline.execute(req, res, 'openai/images');
    } catch (err) {
      logger.error('Image generation error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
    }
  }

  getPipeline() {
    if (!this._pipeline) {
      const { Pipeline } = require('./llm/pipeline');
      this._pipeline = new Pipeline();
    }
    return this._pipeline;
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        getDb();
        logger.info('Gateway database initialized');

        // Restore persisted load balancer routing strategy
        try {
          const db = getDb();
          const row = db.prepare("SELECT value FROM systems WHERE key = 'lb_routing_strategy'").get();
          if (row && row.value) {
            const { loadBalancer, VALID_STRATEGIES } = require('./biz/loadBalancer');
            if (VALID_STRATEGIES.has(row.value)) {
              loadBalancer.setStrategy(row.value);
              logger.info(`Restored routing strategy from DB: ${row.value}`);
            }
          }
        } catch (strategyErr) {
          logger.warn('Failed to restore routing strategy', { error: strategyErr.message });
        }
      } catch (err) {
        logger.error('Failed to initialize database', { error: err.message });
        return reject(err);
      }

      this.server = this.app.listen(this.port, '127.0.0.1', () => {
        logger.info(`Gateway server started on http://127.0.0.1:${this.port}`);
        resolve(this.server);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          this.server = this.app.listen(this.port, '127.0.0.1', () => {
            logger.info(`Gateway server started on http://127.0.0.1:${this.port}`);
            resolve(this.server);
          });
        } else {
          reject(err);
        }
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this._pipeline && this._pipeline.shutdown) {
        this._pipeline.shutdown();
      }
      if (this.server) {
        // Stop accepting new connections
        this.server.close(() => {
          logger.info('Gateway server stopped');
          cacheManager.close();
          closeDb();
          resolve();
        });
        // Force close all idle keep-alive connections after a grace period
        // so pending requests can finish but we don't wait forever
        setTimeout(() => {
          if (this.server && typeof this.server.closeAllConnections === 'function') {
            this.server.closeAllConnections();
          }
        }, 5000);
      } else {
        cacheManager.close();
        closeDb();
        resolve();
      }
    });
  }
}

module.exports = { GatewayServer };
