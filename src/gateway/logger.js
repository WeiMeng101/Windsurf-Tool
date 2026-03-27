'use strict';

const winston = require('winston');
const path = require('path');

let logDir;
try {
  const { app } = require('electron');
  logDir = path.join(app.getPath('userData'), 'logs');
} catch {
  logDir = path.join(__dirname, '..', '..', 'logs');
}

const logger = winston.createLogger({
  level: process.env.GATEWAY_LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'gateway' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [Gateway] ${level}: ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

module.exports = logger;
