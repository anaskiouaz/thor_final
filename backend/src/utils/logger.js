/**
 * logger.js — Structured JSON logging with file rotation (Thor v2)
 */

'use strict';

const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const logDir = process.env.LOG_DIR || path.join(__dirname, '../logs');
const logLevel = process.env.LOG_LEVEL || 'info';
const logToFile = (process.env.LOG_TO_FILE ?? 'true') === 'true';

// Ensure log directory exists
if (logToFile && !fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// ─── Formats ─────────────────────────────────────────────────────────────────

const jsonFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, component, message, ...meta }) => {
        const compStr = component ? ` [\x1b[36m${component}\x1b[0m]` : '';
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] ${level}${compStr} ${message}${metaStr}`;
    })
);

// ─── Transports ──────────────────────────────────────────────────────────────

const transports = [
    new winston.transports.Console({
        level: logLevel,
        format: consoleFormat
    })
];

if (logToFile) {
    transports.push(new winston.transports.DailyRotateFile({
        filename: path.join(logDir, 'thor-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: process.env.LOG_MAX_SIZE_MB ? `${process.env.LOG_MAX_SIZE_MB}m` : '20m',
        maxFiles: process.env.LOG_MAX_FILES || '14d',
        format: jsonFormat,
        level: logLevel
    }));

    // Errors separate file
    transports.push(new winston.transports.DailyRotateFile({
        filename: path.join(logDir, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '10m',
        maxFiles: '30d',
        format: jsonFormat,
        level: 'error'
    }));
}

// ─── Logger Instance ─────────────────────────────────────────────────────────

const logger = winston.createLogger({
    level: logLevel,
    transports: transports,
    exitOnError: false
});

/**
 * Standardized trade logger helper.
 */
logger.logTrade = (trade, message, level = 'info', extraCtx = {}) => {
    const ctx = {
        component: 'Trading',
        tradeId: trade.id,
        token: trade.token_address,
        symbol: trade.token_symbol,
        wallet: trade.wallet_source,
        dex: trade.dex_used,
        ...extraCtx
    };
    logger.log(level, message, ctx);
};

module.exports = logger;
