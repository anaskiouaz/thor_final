'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const CircuitBreaker = require('../utils/CircuitBreaker');

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const SOLSCAN_API = 'https://pro-api.solscan.io/v2.0';
const SOLSCAN_HEADERS = { 
    'Authorization': `Bearer ${process.env.SOLSCAN_API_KEY}`,
    'Content-Type': 'application/json'
};

const heliusBreaker = new CircuitBreaker('HeliusAPI', {
    failureThreshold: 3,
    cooldownPeriod: 60000 // 1 minute cooldown for 429s
});

async function fetchJSON(url, options = {}, timeoutMs = 10_000) {
    try {
        const { data } = await axios({
            url,
            method: options.method || 'GET',
            data: options.body ? JSON.parse(options.body) : undefined,
            headers: options.headers,
            timeout: timeoutMs
        });
        return data;
    } catch (err) {
        if (err.response?.status === 429) throw new Error('HTTP 429: Too Many Requests');
        throw new Error(err.response?.data?.message || err.message);
    }
}

/**
 * Perform a Helius RPC call with circuit breaker and backup fallback.
 */
async function rpc(method, params) {
    return heliusBreaker.fire(async () => {
        const { rpcUrl } = config.getHeliusConfig();
        try {
            const data = await fetchJSON(rpcUrl, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) 
            });
            if (data.error) throw new Error(`Helius RPC error: ${JSON.stringify(data.error)}`);
            return data.result;
        } catch (err) {
            if ((err.message.includes('429') || err.message.includes('403')) && config.switchToBackup()) {
                logger.info({ component: 'Helius' }, 'Switched to backup RPC after 429/403');
                return rpc(method, params);
            }
            throw err;
        }
    });
}

/**
 * Fetch last purchased tokens using Solscan or Helius Enhanced API.
 */
async function getLastPurchasedTokens(walletAddress, limit = 10) {
    // 1. Try Solscan (if key available)
    if (process.env.SOLSCAN_API_KEY) {
        try {
            const data = await fetchJSON(`${SOLSCAN_API}/account/defi/activities?address=${walletAddress}&activity_type[]=ACTIVITY_AGG_TOKEN_SWAP&page=1&page_size=20&sort_by=block_time&sort_order=desc`, { headers: SOLSCAN_HEADERS });
            const tokens = [];
            const seen = new Set();
            for (const act of (data?.data ?? [])) {
                for (const route of (act.routers ?? [])) {
                    if (route.token2 && route.token2 !== WRAPPED_SOL && !seen.has(route.token2) && route.token2_account) {
                        seen.add(route.token2);
                        tokens.push({ 
                            mint: route.token2, 
                            signature: act.trans_id, 
                            blockTime: act.block_time, 
                            amountIn: route.amount1, 
                            tokenIn: route.token1, 
                            amountOut: route.amount2, 
                            source: 'solscan' 
                        });
                    }
                }
                if (tokens.length >= limit) break;
            }
            if (tokens.length > 0) return tokens.slice(0, limit);
        } catch (err) {
            logger.warn({ component: 'Helius', stack: err.stack }, `Solscan fetch failed: ${err.message}`);
        }
    }

    // 2. Try Helius Enhanced API
    return heliusBreaker.fire(async () => {
        const hConfig = config.getHeliusConfig();
        const apiKey = (hConfig.apiKey || process.env.HELIUS_API_KEY || '').trim().replace(/[\n\r]/g, '');
        
        if (!apiKey) {
            logger.warn({ component: 'Helius' }, 'No Helius API key found for enhanced fetch');
            return [];
        }

        logger.info({ component: 'Helius' }, 'Attempting Helius call with key: ' + apiKey.slice(0, 5) + '...');

        try {
            // Helius Enhanced API standard endpoint
            const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${apiKey}&type=SWAP&limit=20`;
            
            logger.info({ component: 'Helius' }, `🔍 Fetching enhanced txs for ${walletAddress.slice(0, 8)}...`);
            const data = await fetchJSON(url);
            
            if (!Array.isArray(data)) {
                logger.warn({ component: 'Helius' }, `Unexpected Helius response: ${typeof data}`);
                return [];
            }

            const tokens = [];
            const seen = new Set();
            for (const tx of data) {
                for (const transfer of (tx.tokenTransfers ?? [])) {
                    if (transfer.toUserAccount === walletAddress && transfer.mint !== WRAPPED_SOL && !seen.has(transfer.mint)) {
                        seen.add(transfer.mint);
                        tokens.push({ 
                            mint: transfer.mint, 
                            signature: tx.signature, 
                            blockTime: tx.timestamp, 
                            amountOut: transfer.tokenAmount, 
                            source: 'helius_enhanced' 
                        });
                    }
                }
                if (tokens.length >= limit) break;
            }
            return tokens.slice(0, limit);
        } catch (err) {
            if ((err.message.includes('429') || err.message.includes('403')) && config.switchToBackup()) {
                return getLastPurchasedTokens(walletAddress, limit);
            }
            throw err;
        }
    });
}

module.exports = {
    rpc,
    getLastPurchasedTokens
};
