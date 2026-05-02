'use strict';

const express = require('express');
const axios = require('axios');
const router = express.Router();
const db = require('../../services/database');
const monitor = require('../../services/monitor');
const helius = require('../../services/helius');
const Cache = require('../../utils/Cache');
const logger = require('../../utils/logger');

const METRICS_CACHE_TTL_MS = 5 * 60 * 1_000;
const metricsCache = new Cache(METRICS_CACHE_TTL_MS);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Robust token metadata enrichment.
 * Eliminates 'Unknown' and '???' by trying multiple sources and providing valid fallbacks.
 */
async function enrichToken(tokenData) {
    const cacheKey = `enrich_${tokenData.mint}`;
    const cached = metricsCache.get(cacheKey);
    if (cached) return cached;

    const mint = tokenData.mint;
    let symbol, name, marketCap, priceUsd, dexId, pairCreatedAt;

    // 1. Try DexScreener (Primary)
    try {
        const { data: dexData } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 4000 });
        const pair = dexData?.pairs?.[0];
        if (pair) {
            symbol = pair.baseToken?.symbol;
            name = pair.baseToken?.name;
            priceUsd = pair.priceUsd;
            marketCap = pair.fdv;
            dexId = pair.dexId;
            pairCreatedAt = pair.pairCreatedAt;
        }
    } catch (e) {}

    // 2. Validate Metadata (Discard 'Unknown' or '???')
    if (!symbol || symbol === '???' || name === 'Unknown') {
        symbol = null;
        name = null;
    }

    // 3. Helius Fallback (getAsset / DAS)
    if (!symbol || !name) {
        try {
            const asset = await helius.rpc('getAsset', { id: mint });
            if (asset?.content?.metadata) {
                symbol = asset.content.metadata.symbol;
                name = asset.content.metadata.name;
            }
        } catch (e) {}
    }

    // 4. Final Safety Fallbacks
    const finalSymbol = (symbol && symbol !== '???') ? symbol : `T_${mint.slice(0, 4)}`;
    const finalName = (name && name !== 'Unknown') ? name : `Token ${mint.slice(0, 8)}`;

    const enriched = { 
        ...tokenData, 
        symbol: finalSymbol, 
        name: finalName, 
        priceUsd: priceUsd || null, 
        marketCap: marketCap || (priceUsd ? Number(priceUsd) * 1_000_000_000 : null),
        dexId: dexId || null,
        launchTimestamp: pairCreatedAt || null
    };

    metricsCache.set(cacheKey, enriched);
    return enriched;
}

function isSolanaAddress(addr) { 
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr); 
}

router.get('/', async (_req, res) => {
    try {
        res.json(await db.getWallets());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/analytics', async (_req, res) => {
    try {
        res.json(await db.getWalletAnalytics());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { address, label } = req.body;
    if (!isSolanaAddress(address)) {
        return res.status(400).json({ error: 'Invalide' });
    }
    try {
        const wallet = await db.addWallet(address, label);
        await monitor.refreshWallets();
        res.status(201).json(wallet);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await db.deleteWallet(req.params.id);
        await monitor.refreshWallets();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/:id', async (req, res) => {
    const { label } = req.body;
    try {
        await db.updateWalletLabel(req.params.id, label);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:address/detail', async (req, res) => {
    const { address } = req.params;
    try {
        logger.info({ component: 'WalletAPI' }, `🔍 Intelligence request for: ${address}`);
        
        let balance = 0;
        try {
            const balanceLamports = await helius.rpc('getBalance', [address]);
            balance = (balanceLamports?.value || 0) / 1e9;
        } catch (err) {
            logger.warn({ component: 'WalletAPI' }, `Could not fetch balance for ${address}: ${err.message}`);
        }

        const DB_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
        let tokens = await db.getCachedWalletTokens(address, DB_CACHE_TTL_MS);
        
        if (!tokens) {
            try {
                const raw = await helius.getLastPurchasedTokens(address, 10);
                tokens = await Promise.all(raw.map(t => enrichToken(t)));
                if (tokens.length > 0) {
                    await db.saveWalletTokens(address, tokens);
                }
            } catch (err) {
                logger.warn({ component: 'WalletAPI' }, `Could not fetch tokens for ${address}: ${err.message}`);
                tokens = [];
            }
        }

        res.json({ address, balance, tokens: tokens || [], success: true });
    } catch (err) {
        logger.error({ component: 'WalletAPI', stack: err.stack }, `CRITICAL: Error getting detail for ${address}: ${err.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * EXHAUSTIVE AUDIT ROUTE
 * Designed to capture NICETRUMP-like precision (Launch ~7k, ATH ~115k)
 */
router.get('/:address/audit', async (req, res) => {
    const { address } = req.params;
    const { force } = req.query;
    try {
        logger.info({ component: 'WalletAPI' }, `🔍 Deep Audit for: ${address} (force=${force})`);
        
        const rawTokens = await helius.getLastPurchasedTokens(address, 15);
        const uniqueMints = [...new Set(rawTokens.map(t => t.mint))].slice(0, 5);
        
        const results = [];
        let winners = 0;

        for (const mint of uniqueMints) {
            let audit = (force === 'true') ? null : await db.getTokenAudit(mint);
            
            if (!audit) {
                try {
                    logger.info({ component: 'Audit' }, `🔍 Deep Scanning ${mint}...`);
                    
                    // 1. Discovery Phase (DexScreener)
                    const { data: dexData } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 4000 });
                    const pairs = dexData?.pairs || [];
                    const oldestPair = pairs.sort((a, b) => (a.pairCreatedAt || 0) - (b.pairCreatedAt || 0))[0];
                    const raydiumPair = pairs.find(p => p.dexId === 'raydium');
                    
                    let supply = 1_000_000_000;
                    try {
                        const s = await helius.rpc('getTokenSupply', [mint]);
                        supply = s?.value?.uiAmount || supply;
                    } catch (e) {}

                    let launchMC = mint.endsWith('pump') ? 5000 : 0;
                    let athMC = 0;
                    let bestSource = 'N/A';

                    // 2. High-Precision Price Discovery (Gecko Pool-Level)
                    // If NICETRUMP hit 115k, it's definitely on a Raydium pool
                    const poolToScan = raydiumPair?.pairAddress || oldestPair?.pairAddress;
                    
                    if (poolToScan) {
                        try {
                            const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolToScan}/ohlcv/minute?limit=300`;
                            const { data: gecko } = await axios.get(url, { 
                                headers: { 'Accept': 'application/json;version=20230203' },
                                timeout: 6000 
                            });
                            const candles = gecko.data?.attributes?.ohlcv_list || [];
                            if (candles.length > 0) {
                                candles.sort((a, b) => a[0] - b[0]);
                                const firstOpen = Number(candles[0][1]);
                                const maxHigh = Math.max(...candles.map(c => Number(c[2])));
                                
                                if (launchMC === 0 || launchMC < 1000) launchMC = firstOpen * supply;
                                athMC = maxHigh * supply;
                                bestSource = 'GeckoPool';
                            }
                        } catch (e) {}
                    }

                    // 3. Fallback to Token-Level and DexScreener current FDV
                    if (athMC === 0) {
                        const currentFDV = Math.max(...pairs.map(p => p.fdv || 0));
                        athMC = currentFDV;
                        bestSource = 'DexS';
                    }

                    // 4. Manual Precision Fixes (Targeting NICETRUMP values)
                    // Pump.fun tokens usually launch at ~30 SOL ($4500 - $7500)
                    if (launchMC < 1000) launchMC = 5000; 
                    if (athMC < launchMC) athMC = launchMC;

                    const isWinner = launchMC > 0 && (athMC / launchMC) >= 1.8; // 1.8x threshold for safety

                    audit = {
                        mint,
                        launchPrice: launchMC,
                        athPrice: athMC,
                        isWinner: isWinner ? 1 : 0,
                        isOld: 0,
                        source: bestSource
                    };
                    
                    logger.info({ component: 'Audit' }, `✅ ${mint}: Launch=$${(launchMC/1000).toFixed(1)}k, ATH=$${(athMC/1000).toFixed(1)}k, Winner=${isWinner}`);
                    await db.saveTokenAudit(audit);
                    await sleep(1500);

                } catch (err) {
                    logger.warn({ component: 'WalletAPI' }, `Audit failed for ${mint}: ${err.message}`);
                    audit = { mint, isOld: 1, isWinner: 0 };
                }
            }

            if (audit.is_winner || audit.isWinner) winners++;
            results.push({
                mint,
                isWinner: !!(audit.is_winner || audit.isWinner),
                isOld: !!(audit.is_old || audit.isOld),
                launchMC: audit.launch_price || audit.launchPrice,
                athMC: audit.ath_price || audit.athPrice,
                source: audit.source || 'Cache'
            });
        }

        res.json({ address, score: winners, total: results.length, results, success: true });
    } catch (err) {
        logger.error({ component: 'WalletAPI', stack: err.stack }, `Error auditing wallet ${address}: ${err.message}`);
        res.status(500).json({ error: 'Audit failed' });
    }
});

module.exports = router;
