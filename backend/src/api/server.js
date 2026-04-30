'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('../services/database');
const monitor = require('../services/monitor');
const telegram = require('../services/telegram');
const config = require('../config');
const trading = require('../services/trading');
const autosell = require('../services/autosell');
const logger = require('../utils/logger');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const MEMORY_CACHE_TTL_MS = 3 * 60 * 1_000;
const DB_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const SOLSCAN_API = 'https://pro-api.solscan.io/v2.0';
const SOLSCAN_HEADERS = { token: process.env.SOLSCAN_API_KEY };

const DEX_PROGRAMS = new Set([
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'PumpkinsEq8xENVZE62QqojeZT6J9x5sHze1P5m4P6c',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isSolanaAddress(addr) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr); }

async function fetchJSON(url, options = {}, timeoutMs = 10_000) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function heliusRpc(method, params) {
    const { rpcUrl } = config.getHeliusConfig();
    try {
        const data = await fetchJSON(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (data.error) throw new Error(`Helius RPC error: ${JSON.stringify(data.error)}`);
        return data.result;
    } catch (err) {
        if ((err.message.includes('429') || err.message.includes('403')) && config.switchToBackup()) return heliusRpc(method, params);
        throw err;
    }
}

async function getLastPurchasedTokens(walletAddress, limit = 10) {
    if (process.env.SOLSCAN_API_KEY) {
        try {
            const data = await fetchJSON(`${SOLSCAN_API}/account/defi/activities?address=${walletAddress}&activity_type[]=ACTIVITY_AGG_TOKEN_SWAP&page=1&page_size=20&sort_by=block_time&sort_order=desc`, { headers: SOLSCAN_HEADERS });
            const tokens = [];
            const seen = new Set();
            for (const act of (data?.data ?? [])) {
                for (const route of (act.routers ?? [])) {
                    if (route.token2 && route.token2 !== WRAPPED_SOL && !seen.has(route.token2) && route.token2_account) {
                        seen.add(route.token2);
                        tokens.push({ mint: route.token2, signature: act.trans_id, blockTime: act.block_time, amountIn: route.amount1, tokenIn: route.token1, amountOut: route.amount2, source: 'solscan' });
                    }
                }
                if (tokens.length >= limit) break;
            }
            if (tokens.length > 0) return tokens.slice(0, limit);
        } catch (err) {}
    }

    const { txUrl } = config.getHeliusConfig();
    if (txUrl) {
        try {
            const baseUrl = txUrl.split('?')[0].replace('/v0/transactions', `/v0/addresses/${walletAddress}/transactions`);
            const key = txUrl.split('api-key=')[1]?.split('&')[0];
            const data = await fetchJSON(`${baseUrl}?api-key=${key}&type=SWAP&limit=20`);
            const tokens = [];
            const seen = new Set();
            for (const tx of (data ?? [])) {
                for (const transfer of (tx.tokenTransfers ?? [])) {
                    if (transfer.toUserAccount === walletAddress && transfer.mint !== WRAPPED_SOL && !seen.has(transfer.mint)) {
                        seen.add(transfer.mint);
                        tokens.push({ mint: transfer.mint, signature: tx.signature, blockTime: tx.timestamp, amountOut: transfer.tokenAmount, source: 'helius_enhanced' });
                    }
                }
                if (tokens.length >= limit) break;
            }
            if (tokens.length > 0) return tokens.slice(0, limit);
        } catch (err) {}
    }

    return []; // Fallback empty
}

async function enrichToken(tokenData) {
    try {
        const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${tokenData.mint}`, {}, 6_000);
        const pair = data?.pairs?.[0];
        return { ...tokenData, symbol: pair?.baseToken?.symbol || '???', name: pair?.baseToken?.name || 'Unknown', priceUsd: pair?.priceUsd || null, marketCap: pair?.marketCap || null, volume24h: pair?.volume?.h24 || null, liquidity: pair?.liquidity?.usd || null, dexId: pair?.dexId || null };
    } catch { return { ...tokenData, symbol: '???', name: 'Unknown', priceUsd: null }; }
}

const app = express();
const server = http.createServer(app);
const walletCache = new Map();

app.use(cors());
app.use(express.json());

const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();
wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', data: { timestamp: Date.now() } }));
});

function broadcastWs(message) {
    for (const ws of wsClients) if (ws.readyState === 1) try { ws.send(message); } catch {}
}
trading.broadcast = broadcastWs;

app.get('/api/wallets', async (_req, res) => res.json(await db.getWallets()));
app.post('/api/wallets', async (req, res) => {
    const { address, label } = req.body;
    if (!isSolanaAddress(address)) return res.status(400).json({ error: 'Invalide' });
    try {
        const wallet = await db.addWallet(address, label);
        await monitor.refreshWallets();
        res.status(201).json(wallet);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/wallets/:id', async (req, res) => {
    await db.deleteWallet(req.params.id);
    await monitor.refreshWallets();
    res.json({ success: true });
});

app.get('/api/trades/recent', async (req, res) => res.json(await db.getRecentTrades(parseInt(req.query.limit) || 10)));
app.get('/api/trades/open', async (_req, res) => res.json(await db.getOpenTrades()));
app.get('/api/trades/stats', async (_req, res) => res.json(await db.getTradeStats()));
app.get('/api/config', (_req, res) => res.json({ ...config.getTradingConfig(), walletAddress: trading.wallet?.publicKey?.toString() ?? null }));

app.get('/api/wallets/:address/tokens', async (req, res) => {
    const { address } = req.params;
    const dbCached = await db.getCachedWalletTokens(address, DB_CACHE_TTL_MS);
    if (dbCached) return res.json({ wallet: address, tokens: dbCached, fromCache: true });

    const raw = await getLastPurchasedTokens(address, 10);
    const enriched = await Promise.all(raw.map(t => enrichToken(t)));
    await db.saveWalletTokens(address, enriched);
    res.json({ wallet: address, tokens: enriched, fromCache: false });
});

server.listen(PORT, '0.0.0.0', () => {
    logger.info({ component: 'Server' }, `🚀 Thor v2 — http://0.0.0.0:${PORT}`);
    monitor.start();
    autosell.start();
});
