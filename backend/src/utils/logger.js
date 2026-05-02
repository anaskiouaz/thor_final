/**
 * logger.js — Robust Structured Logging (Thor v2)
 * Handles both patterns: 
 * 1. logger.info('Message', { component: 'X' })
 * 2. logger.info({ component: 'X' }, 'Message')
 */

'use strict';

const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

const logDir = process.env.LOG_DIR || path.join(__dirname, '../logs');
const logLevel = process.env.LOG_LEVEL || 'info';
const logToFile = (process.env.LOG_TO_FILE ?? 'true') === 'true';

if (logToFile && !fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Custom format to handle the "reversed" pattern: logger.info({ meta }, 'message')
 * Winston normally expects logger.info('message', { meta })
 */
const handleReversedArgs = winston.format((info) => {
    // If the "message" is an object and we have splat arguments, 
    // it likely means the user did logger.info({ component: 'X' }, 'Real Message')
    const splat = info[Symbol.for('splat')];
    if (typeof info.message === 'object' && splat && splat.length > 0) {
        const meta = info.message;
        const realMessage = splat[0];
        
        // Merge meta into info
        Object.assign(info, meta);
        info.message = realMessage;
        
        // Remove the message from splat so it's not processed again
        info[Symbol.for('splat')] = splat.slice(1);
    }
    return info;
});

const consoleFormat = winston.format.combine(
    handleReversedArgs(),
    winston.format.splat(),
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.printf((info) => {
        const { timestamp, level, component, message, stack, ...meta } = info;
        const compStr = component ? ` [\x1b[36m${component}\x1b[0m]` : '';
        
        let msgStr = stack || (typeof message === 'object' ? JSON.stringify(message) : message);

        // Filter metadata to show in console (exclude internal winston symbols)
        const metaEntries = Object.entries(meta).filter(([k]) => 
            typeof k === 'string' && !['timestamp', 'level', 'message', 'component', 'stack'].includes(k)
        );
        const metaStr = metaEntries.length ? ` \x1b[2m${JSON.stringify(Object.fromEntries(metaEntries))}\x1b[0m` : '';
        
        return `[${timestamp}] ${level}${compStr} ${msgStr}${metaStr}`;
    })
);

const jsonFormat = winston.format.combine(
    handleReversedArgs(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

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
        maxSize: '20m',
        maxFiles: '14d',
        format: jsonFormat,
        level: logLevel
    }));
}

const logger = winston.createLogger({
    level: logLevel,
    transports: transports,
    exitOnError: false
});

module.exports = logger;
