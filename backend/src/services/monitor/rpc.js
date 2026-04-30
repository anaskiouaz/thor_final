'use strict';

const config = require('../../config');
const logger = require('../../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Perform a Helius RPC call with automatic failover and backup handling.
 */
async function heliusRpc(method, params) {
    const { rpcUrl } = config.getHeliusConfig();
    logger.debug({ component: 'Monitor API' }, `Helius RPC: ${method}`);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    
    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Helius ${method} HTTP ${res.status}: ${text.slice(0, 120)}`);
        }
        const json = await res.json();
        if (json.error) throw new Error(`Helius ${method} RPC error: ${JSON.stringify(json.error)}`);
        return json.result;
    } catch (err) {
        if (err.message.includes('429') || err.message.includes('403')) {
            if (config.switchToBackup()) {
                // Notify the monitor to reconnect websockets with the new key
                if (global.solanaMonitor) global.solanaMonitor.reconnect();
                return heliusRpc(method, params);
            }
        }
        throw err;
    }
}

/**
 * Retry helper for RPC calls.
 */
async function withRetry(fn, retries = 3, baseDelayMs = 1_500) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
        try { return await fn(); }
        catch (err) {
            lastErr = err;
            if (attempt < retries - 1) {
                const delay = baseDelayMs * 2 ** attempt;
                logger.warn({ component: 'Monitor' }, `Retry ${attempt + 1}/${retries} in ${delay}ms — ${err.message}`);
                await sleep(delay);
            }
        }
    }
    throw lastErr;
}

module.exports = {
    heliusRpc,
    withRetry,
    sleep
};
