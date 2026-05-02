'use strict';

const config = require('../../config');
const logger = require('../../utils/logger');
const CircuitBreaker = require('../../utils/CircuitBreaker');
const heliometer = require('../heliometer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const heliusBreaker = new CircuitBreaker('MonitorRPC', {
    failureThreshold: 3,
    cooldownPeriod: 30000
});

/**
 * Perform a Helius RPC call with automatic failover and backup handling.
 */
async function heliusRpc(method, params) {
    return heliusBreaker.fire(async () => {
        const rpcUrl = heliometer.getRpcUrl();
        logger.debug({ component: 'Monitor API' }, `RPC Call (${method}) via ${rpcUrl.slice(0, 30)}...`);
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
                if (res.status === 429) throw new Error('HTTP 429: Too Many Requests');
                throw new Error(`Helius ${method} HTTP ${res.status}: ${text.slice(0, 120)}`);
            }
            const json = await res.json();
            if (json.error) throw new Error(`Helius ${method} RPC error: ${JSON.stringify(json.error)}`);
            return json.result;
        } catch (err) {
            if (err.message.includes('429') || err.message.includes('403')) {
                logger.error({ component: 'Monitor' }, `🔴 RPC Rate Limit (429) detected! Triggering Heliometer failover...`);
                await heliometer.forceFailover();
                
                // Notify the monitor to reconnect websockets with the new key if possible
                if (global.solanaMonitor) global.solanaMonitor.reconnect();
                
                // Retry the request once with the new RPC
                return heliusRpc(method, params);
            }
            throw err;
        }
    });
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
