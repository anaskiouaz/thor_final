/**
 * server.js — Express API server + WebSocket (Thor v2)
 * Utilise Helius RPC + Solscan API pour récupérer les 10 derniers tokens achetés.
 * Nouvelles routes pour les trades (copy-trading dashboard).
 */

'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./database');
const monitor = require('./monitor');
const telegram = require('./telegram');
const config = require('./config');
const trading = require('./trading');
const autosell = require('./autosell');
const logger = require('./lib/logger');
require('dotenv').config();

// ─── Constants ───────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const MEMORY_CACHE_TTL_MS = 3 * 60 * 1_000;   // 3 min in-memory cache
const DB_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;  // 24h DB cache
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const SOLSCAN_API = 'https://pro-api.solscan.io/v2.0';
const SOLSCAN_HEADERS = { token: process.env.SOLSCAN_API_KEY };

// DEX identifiables pour filtrer uniquement les swaps
const DEX_PROGRAMS = new Set([
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    'PumpkinsEq8xENVZE62QqojeZT6J9x5sHze1P5m4P6c',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isSolanaAddress(addr) {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

/** Appel JSON avec timeout */
async function fetchJSON(url, options = {}, timeoutMs = 10_000) {
    const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}: ${text.slice(0, 120)}`);
    }
    return res.json();
}

/** Appel Helius JSON-RPC avec failover */
async function heliusRpc(method, params) {
    const { rpcUrl } = config.getHeliusConfig();
    logger.debug({ component: 'API' }, `Helius RPC call: ${method}`);

    try {
        const data = await fetchJSON(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (data.error) throw new Error(`Helius RPC error (${method}): ${JSON.stringify(data.error)}`);
        return data.result;
    } catch (err) {
        // Détecter quota atteint (429 Too Many Requests ou 403 Forbidden sur certains plans)
        if (err.message.includes('429') || err.message.includes('403')) {
            if (config.switchToBackup()) {
                // Réessayer une fois avec la nouvelle config
                return heliusRpc(method, params);
            }
        }
        throw err;
    }
}

// ─── Récupération des tokens achetés (logique principale) ────────────────────

/**
 * Récupère les 10 derniers tokens achetés (swaps) par un wallet.
 *
 * Stratégie :
 * 1. Solscan /account/defi/activities (swap activities) — le plus fiable et rapide
 * 2. Fallback: Helius enhanced transactions (type SWAP)
 * 3. Fallback: scan manuel des signatures Helius RPC
 */
async function getLastPurchasedTokens(walletAddress, limit = 10) {
    // ── Stratégie 1 : Solscan defi activities ────────────────────────────────
    if (process.env.SOLSCAN_API_KEY) {
        logger.info({ component: 'API' }, `Tentative Solscan pour ${walletAddress}...`);
        try {
            const data = await fetchJSON(
                `${SOLSCAN_API}/account/defi/activities?` +
                `address=${walletAddress}&activity_type[]=ACTIVITY_AGG_TOKEN_SWAP&page=1&page_size=20&sort_by=block_time&sort_order=desc`,
                { headers: SOLSCAN_HEADERS }
            );

            const activities = data?.data ?? [];
            const seen = new Set();
            const tokens = [];

            for (const act of activities) {
                // On veut le token REÇU (routers vers le wallet)
                const routers = act.routers ?? [];
                for (const route of routers) {
                    const token2 = route.token2;        // token reçu
                    const token2Account = route.token2_account;
                    if (
                        token2 &&
                        token2 !== WRAPPED_SOL &&
                        !seen.has(token2) &&
                        token2Account // le wallet a bien un compte pour ce token
                    ) {
                        seen.add(token2);
                        tokens.push({
                            mint: token2,
                            signature: act.trans_id,
                            blockTime: act.block_time,
                            amountIn: route.amount1,      // SOL/USDC dépensé
                            tokenIn: route.token1,
                            amountOut: route.amount2,      // tokens reçus
                            source: 'solscan',
                        });
                    }
                }
                if (tokens.length >= limit) break;
            }

            if (tokens.length > 0) {
                logger.info({ component: 'Server' }, `Solscan: ${tokens.length} tokens trouvés pour ${walletAddress}`);
                return tokens.slice(0, limit);
            }
        } catch (err) {
            if (!err.message.includes('401')) {
                console.warn(`[Server] Solscan defi activities failed: ${err.message}`);
            }
        }
    }

    // ── Stratégie 2 : Helius Enhanced Transactions ───────────────────────────
    const { txUrl } = config.getHeliusConfig();
    if (txUrl) {
        logger.info({ component: 'API' }, `Tentative Helius Enhanced pour ${walletAddress}...`);
        try {
            // Reconstruct the URL using the base txUrl from config
            const baseUrl = txUrl.split('?')[0].replace('/v0/transactions', `/v0/addresses/${walletAddress}/transactions`);
            const key = txUrl.split('api-key=')[1]?.split('&')[0];
            const data = await fetchJSON(`${baseUrl}?api-key=${key}&type=SWAP&limit=20`);

            const seen = new Set();
            const tokens = [];

            for (const tx of (data ?? [])) {
                for (const transfer of (tx.tokenTransfers ?? [])) {
                    if (
                        transfer.toUserAccount === walletAddress &&
                        transfer.mint !== WRAPPED_SOL &&
                        !seen.has(transfer.mint)
                    ) {
                        seen.add(transfer.mint);
                        tokens.push({
                            mint: transfer.mint,
                            signature: tx.signature,
                            blockTime: tx.timestamp,
                            amountOut: transfer.tokenAmount,
                            source: 'helius_enhanced',
                        });
                    }
                }
                if (tokens.length >= limit) break;
            }

            if (tokens.length > 0) {
                logger.info({ component: 'Server' }, `Helius Enhanced: ${tokens.length} tokens pour ${walletAddress}`);
                return tokens.slice(0, limit);
            }
        } catch (err) {
            console.warn(`[Server] Helius Enhanced TX failed: ${err.message}`);
        }
    }

    // ── Stratégie 3 : Scan manuel signatures Helius RPC ─────────────────────
    logger.info({ component: 'Server' }, `Fallback: scan signatures pour ${walletAddress}`);
    const seen = new Set();
    const tokens = [];

    try {
        const sigInfos = await heliusRpc('getSignaturesForAddress', [
            walletAddress,
            { limit: 40, commitment: 'confirmed' },
        ]);

        for (const sigInfo of sigInfos) {
            if (tokens.length >= limit) break;
            await sleep(150);

            const tx = await heliusRpc('getTransaction', [
                sigInfo.signature,
                { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' },
            ]).catch(() => null);

            if (!tx?.meta) continue;

            // Vérifier si DEX impliqué
            const programIds = [
                ...(tx.transaction?.message?.instructions ?? []).map(ix =>
                    ix.programId?.toString() ?? ix.program
                ),
                ...(tx.meta?.innerInstructions ?? []).flatMap(i =>
                    i.instructions.map(ix => ix.programId?.toString() ?? ix.program)
                ),
            ].filter(Boolean);

            if (!programIds.some(p => DEX_PROGRAMS.has(p))) continue;

            // Trouver les tokens reçus
            const preByMint = {};
            for (const b of tx.meta.preTokenBalances ?? []) {
                if (b.owner === walletAddress && b.mint !== WRAPPED_SOL) {
                    preByMint[b.mint] = BigInt(b.uiTokenAmount?.amount || '0');
                }
            }

            for (const b of tx.meta.postTokenBalances ?? []) {
                if (b.owner !== walletAddress || b.mint === WRAPPED_SOL) continue;
                const pre = preByMint[b.mint] ?? 0n;
                const post = BigInt(b.uiTokenAmount?.amount || '0');
                if (post > pre && !seen.has(b.mint)) {
                    seen.add(b.mint);
                    tokens.push({
                        mint: b.mint,
                        signature: sigInfo.signature,
                        blockTime: tx.blockTime,
                        amountOut: Number(post - pre) / 10 ** (b.uiTokenAmount?.decimals ?? 6),
                        source: 'rpc_scan',
                    });
                }
            }
        }
    } catch (err) {
        console.warn(`[Server] Scan signatures échoué: ${err.message}`);
    }

    return tokens.slice(0, limit);
}

/**
 * Enrichit un token avec son prix via DexScreener (gratuit, pas de clé).
 */
async function enrichToken(tokenData) {
    logger.info({ component: 'API' }, `Enrichissement token: ${tokenData.symbol || '???'} (${tokenData.mint.slice(0, 8)}...) via DexScreener`);
    try {
        const data = await fetchJSON(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenData.mint}`,
            {},
            6_000
        );
        const pair = data?.pairs?.[0];
        return {
            ...tokenData,
            symbol: pair?.baseToken?.symbol || '???',
            name: pair?.baseToken?.name || 'Unknown',
            priceUsd: pair?.priceUsd || null,
            marketCap: pair?.marketCap || null,
            volume24h: pair?.volume?.h24 || null,
            liquidity: pair?.liquidity?.usd || null,
            pairAddress: pair?.pairAddress || null,
            dexId: pair?.dexId || null,
        };
    } catch {
        return { ...tokenData, symbol: '???', name: 'Unknown', priceUsd: null };
    }
}

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const walletCache = new Map(); // address → { data, timestamp }

app.use(cors());
app.use(express.json());

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    logger.info({ component: 'WS' }, `Client connected (${wsClients.size} total)`);

    ws.on('close', () => {
        wsClients.delete(ws);
        logger.info({ component: 'WS' }, `Client disconnected (${wsClients.size} total)`);
    });

    ws.on('error', () => {
        wsClients.delete(ws);
    });

    // Send initial state
    ws.send(JSON.stringify({
        type: 'connected',
        data: { message: 'Thor v2 WebSocket connected', timestamp: Date.now() },
    }));
});

/**
 * Broadcast a message to all connected WebSocket clients.
 */
function broadcastWs(message) {
    for (const ws of wsClients) {
        if (ws.readyState === 1) { // OPEN
            try { ws.send(message); } catch { /* ignore */ }
        }
    }
}

// Wire up the broadcast function to the trading service
trading.broadcast = broadcastWs;

// ─── Routes — Wallets ────────────────────────────────────────────────────────

/** GET /api/wallets — liste tous les wallets surveillés */
app.get('/api/wallets', async (_req, res) => {
    try {
        res.json(await db.getWallets());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** POST /api/wallets — ajouter un wallet */
app.post('/api/wallets', async (req, res) => {
    const { address, label } = req.body;
    if (!address) return res.status(400).json({ error: 'address requis' });
    if (!isSolanaAddress(address)) return res.status(400).json({ error: 'Adresse Solana invalide' });

    try {
        const wallet = await db.addWallet(address, label);
        await monitor.refreshWallets();
        await telegram.sendMessage(
            `✅ *Wallet ajouté*\nLabel: ${label || '_aucun_'}\n\`${address}\``
        );
        res.status(201).json(wallet);
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Wallet déjà surveillé.' });
        }
        logger.error({ component: 'Server' }, `addWallet error: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/** DELETE /api/wallets/:id — supprimer un wallet */
app.delete('/api/wallets/:id', async (req, res) => {
    try {
        await db.deleteWallet(req.params.id);
        await monitor.refreshWallets();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Routes — Detections ─────────────────────────────────────────────────────

/** GET /api/detections — log des détections */
app.get('/api/detections', async (_req, res) => {
    try {
        res.json(await db.getDetections());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Routes — Trades (Thor v2) ───────────────────────────────────────────────

/** GET /api/trades/recent — 10 derniers trades (dashboard) */
app.get('/api/trades/recent', async (_req, res) => {
    try {
        const limit = parseInt(_req.query.limit) || 10;
        const trades = await db.getRecentTrades(limit);
        res.json(trades);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/trades/open — positions ouvertes */
app.get('/api/trades/open', async (_req, res) => {
    try {
        const trades = await db.getOpenTrades();
        res.json(trades);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/trades/stats — statistiques globales */
app.get('/api/trades/stats', async (_req, res) => {
    try {
        const stats = await db.getTradeStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/trades/:id — détail d'un trade */
app.get('/api/trades/:id', async (req, res) => {
    try {
        const trade = await db.getTradeById(parseInt(req.params.id));
        if (!trade) return res.status(404).json({ error: 'Trade not found' });
        res.json(trade);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/config — configuration active */
app.get('/api/config', (_req, res) => {
    const tradingConfig = config.getTradingConfig();
    res.json({
        ...tradingConfig,
        walletConfigured: !!trading.wallet,
        walletAddress: trading.wallet?.publicKey?.toString() ?? null,
    });
});

// ─── Routes — Wallet Tokens (legacy) ─────────────────────────────────────────

/**
 * GET /api/wallets/:address/tokens
 * Retourne les 10 derniers memecoins achetés par le wallet.
 */
app.get('/api/wallets/:address/tokens', async (req, res) => {
    const { address } = req.params;
    if (!isSolanaAddress(address)) return res.status(400).json({ error: 'Adresse invalide' });

    // 1. Memory cache (3 min)
    const cached = walletCache.get(address);
    if (cached && Date.now() - cached.timestamp < MEMORY_CACHE_TTL_MS) {
        return res.json(cached.data);
    }

    // 2. DB cache (24h)
    try {
        const dbCached = await db.getCachedWalletTokens(address, DB_CACHE_TTL_MS);
        if (dbCached && dbCached.length > 0) {
            logger.info({ component: 'Server' }, `✅ DB CACHE HIT pour ${address} (${dbCached.length} tokens) - Pas de requête API nécessaire.`);
            const responseData = {
                wallet: address,
                chain: 'solana',
                count: dbCached.length,
                tokens: dbCached,
                fetchedAt: new Date().toISOString(),
                fromCache: true,
            };
            walletCache.set(address, { data: responseData, timestamp: Date.now() });
            return res.json(responseData);
        } else {
            logger.info({ component: 'Server' }, `❌ DB CACHE MISS pour ${address} - Lancement d'une requête API fraîche...`);
        }
    } catch (err) {
        console.warn('[Server] DB cache check failed:', err.message);
    }

    try {
        // 1. Récupérer les tokens bruts
        const rawTokens = await getLastPurchasedTokens(address, 10);

        // 2. Enrichir avec DexScreener (en parallèle, max 5 à la fois pour ne pas spammer)
        const enriched = [];
        for (let i = 0; i < rawTokens.length; i += 5) {
            const batch = rawTokens.slice(i, i + 5);
            const results = await Promise.all(batch.map(t => enrichToken(t)));
            enriched.push(...results);
        }

        // 3. Sauvegarder en DB pour le cache 24h
        try {
            await db.saveWalletTokens(address, enriched);
            logger.info({ component: 'Server' }, `💾 ${enriched.length} tokens sauvegardés en DB pour ${address}`);
        } catch (err) {
            console.warn('[Server] DB save failed:', err.message);
        }

        const responseData = {
            wallet: address,
            chain: 'solana',
            count: enriched.length,
            tokens: enriched,
            fetchedAt: new Date().toISOString(),
            fromCache: false,
        };

        walletCache.set(address, { data: responseData, timestamp: Date.now() });
        res.json(responseData);

    } catch (err) {
        logger.error({ component: 'Server' }, `/tokens error pour ${address}: ${err.message}`);
        res.status(500).json({ error: 'Impossible de récupérer les tokens', detail: err.message });
    }
});

/**
 * GET /api/wallets/:address/detail
 * Infos générales du wallet: balance SOL + tokens achetés.
 */
app.get('/api/wallets/:address/detail', async (req, res) => {
    const { address } = req.params;
    if (!isSolanaAddress(address)) return res.status(400).json({ error: 'Adresse invalide' });

    const cached = walletCache.get(`detail:${address}`);
    if (cached && Date.now() - cached.timestamp < MEMORY_CACHE_TTL_MS) {
        return res.json(cached.data);
    }

    const data = { address, chain: 'solana', balance: 0, tokens: [] };

    try {
        // Balance SOL via Helius RPC
        const balResult = await heliusRpc('getBalance', [address, { commitment: 'confirmed' }]);
        data.balance = (balResult?.value ?? 0) / 1e9;
    } catch (err) {
        logger.warn({ component: 'Server' }, `getBalance failed: ${err.message}`);
    }

    try {
        // Réutiliser le endpoint tokens
        const cached2 = walletCache.get(address);
        if (cached2 && Date.now() - cached2.timestamp < MEMORY_CACHE_TTL_MS) {
            data.tokens = cached2.data.tokens;
        } else {
            // Check DB cache first
            const dbCached = await db.getCachedWalletTokens(address, DB_CACHE_TTL_MS);
            if (dbCached && dbCached.length > 0) {
                data.tokens = dbCached;
            } else {
                const raw = await getLastPurchasedTokens(address, 10);
                const enriched = await Promise.all(raw.map(t => enrichToken(t)));
                data.tokens = enriched;
                // Save to DB
                await db.saveWalletTokens(address, enriched).catch(() => { });
            }
        }
    } catch (err) {
        logger.warn({ component: 'Server' }, `collectTokens failed: ${err.message}`);
    }

    walletCache.set(`detail:${address}`, { data, timestamp: Date.now() });
    res.json(data);
});

/** POST /api/wallets/:address/refresh — invalider le cache d'un wallet */
app.post('/api/wallets/:address/refresh', async (req, res) => {
    const { address } = req.params;
    walletCache.delete(address);
    walletCache.delete(`detail:${address}`);
    // Also clear DB cache
    try {
        await db.clearWalletTokenCache(address);
    } catch (err) {
        logger.warn({ component: 'Server' }, `clearWalletTokenCache failed: ${err.message}`);
    }
    res.json({ success: true, message: 'Cache invalidé (mémoire + DB)' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
    logger.info({ component: 'Server' }, `🚀 Thor v2 — http://0.0.0.0:${PORT}`);
    logger.info({ component: 'Server' }, `🔌 WebSocket — ws://0.0.0.0:${PORT}/ws`);

    const tradingConfig = config.getTradingConfig();
    logger.info({ component: 'Server' }, `⚡ Auto-buy: ${tradingConfig.autoBuyEnabled ? 'ON' : 'OFF'} | Dry run: ${tradingConfig.dryRun ? 'YES' : 'NO'}`);
    logger.info({ component: 'Server' }, `💰 Buy amount: ${tradingConfig.buyAmountEur}€ | Slippage: ${tradingConfig.slippageBps / 100}%`);
    logger.info({ component: 'Server' }, `🎯 TP: +${tradingConfig.tpPercent}% | SL: ${tradingConfig.slPercent}%`);

    if (!process.env.HELIUS_API_KEY) {
        logger.warn({ component: 'Server' }, '⚠ HELIUS_API_KEY manquant — fonctionnalités limitées');
    }
    if (!process.env.SOLSCAN_API_KEY) {
        logger.warn({ component: 'Server' }, '⚠ SOLSCAN_API_KEY manquant — fallback Helius utilisé');
    }

    monitor.start();
    autosell.start();
});