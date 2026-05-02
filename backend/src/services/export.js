'use strict';

const db = require('./database');
const logger = require('../utils/logger');

/**
 * Export trades to JSON format.
 */
async function exportToJson() {
    try {
        const trades = await db.getTradesForExport();
        return JSON.stringify(trades, null, 2);
    } catch (err) {
        logger.error({ component: 'Export' }, `Failed to export to JSON: ${err.message}`);
        throw err;
    }
}

/**
 * Export trades to CSV format.
 */
async function exportToCsv() {
    try {
        const trades = await db.getTradesForExport();
        if (trades.length === 0) return '';

        const headers = Object.keys(trades[0]);
        const rows = trades.map(trade => {
            return headers.map(header => {
                let val = trade[header];
                if (val === null || val === undefined) return '';
                if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
                return val;
            }).join(',');
        });

        return [headers.join(','), ...rows].join('\n');
    } catch (err) {
        logger.error({ component: 'Export' }, `Failed to export to CSV: ${err.message}`);
        throw err;
    }
}

module.exports = {
    exportToJson,
    exportToCsv
};
