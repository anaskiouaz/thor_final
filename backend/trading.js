/**
 * trading.js — Auto-buy engine (Thor v2)
 * Handles automatic token purchases when a tracked wallet trades.
 * Cascade: Pump.fun bonding curve → Raydium/Jupiter
 * Dynamic priority fees, EUR→SOL conversion, entry price T+5s.
 */

'use strict';

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const axios = require('axios');
const db = require('./database');
const telegram = require('./telegram');
const pumpfun = require('./pumpfun');
const raydium = require('./raydium');
const config = require('./config');
const logger = require('./lib/logger');
require('dotenv').config();

// ─── Constants ───────────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_CACHE_TTL_MS = 10_000;   // 10s per token
const SOL_PRICE_CACHE_TTL_MS = 60_000; // 1 min for SOL/EUR price

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// ─── TradingService ──────────────────────────────────────────────────────────

class TradingService {
    constructor() {
        const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
        if (rpcUrl && rpcUrl.startsWith('http')) {
            this.connection = new Connection(rpcUrl, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
        } else {
            logger.error({ component: 'Trading' }, `❌ RPC_URL invalide: ${rpcUrl}`);
        }
        this.wallet = null;
        this._priceCache = new Map();  // mint → { price, ts }
        this._metricsCache = new Map(); // mint → { marketCap, liquidity, ts }
        this._solPriceEur = null;      // { price, ts }
        this._buyLock = new Set();     // prevent double-buys
        this._sellLock = new Set();    // prevent double-sells/concurrent attempts

        // WebSocket broadcast function (set by server.js)
        this.broadcast = null;

        if (process.env.SOLANA_PRIVATE_KEY) {
            try {
                const keyBytes = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
                this.wallet = Keypair.fromSecretKey(keyBytes);
                logger.info({ component: 'Trading' }, `✅ Wallet loaded: ${this.wallet.publicKey.toString()}`);
            } catch (err) {
                logger.error({ component: 'Trading' }, `❌ Invalid SOLANA_PRIVATE_KEY (must be base58 encoded): ${err.message}`);
            }
        } else {
            logger.warn({ component: 'Trading' }, '⚠️ SOLANA_PRIVATE_KEY not set — auto-buy disabled.');
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Auto-buy a token when a tracked wallet is detected trading it.
     * This is the main entry point called by monitor.js.
     * 
     * @param {string} tokenMint - Token address to buy
     * @param {string} walletSource - Address of the tracked wallet that triggered this
     * @param {string} dexType - 'pumpfun' | 'raydium' | 'jupiter' | 'unknown'
     */
    async autoBuy(tokenMint, walletSource, dexType = 'unknown') {
        const tradingConfig = config.getTradingConfig();

        // ── Guards ───────────────────────────────────────────────────────
        if (!tradingConfig.autoBuyEnabled) {
            logger.info({ component: 'Trading' }, `Auto-buy disabled, skipping ${tokenMint}`);
            return null;
        }

        if (!this.wallet) {
            logger.warn({ component: 'Trading' }, `No wallet configured, skipping auto-buy for ${tokenMint}`);
            return null;
        }

        // Prevent duplicate buys
        if (this._buyLock.has(tokenMint)) {
            logger.info({ component: 'Trading' }, `Already buying ${tokenMint}, skipping duplicate`);
            return null;
        }

        // Check if we already have an open trade for this token
        const hasOpen = await db.hasOpenTradeForToken(tokenMint);
        if (hasOpen) {
            logger.info({ component: 'Trading' }, `Already have open trade for ${tokenMint}, skipping`);
            return null;
        }

        this._buyLock.add(tokenMint);

        try {
            // ── DRY RUN mode ─────────────────────────────────────────────
            if (tradingConfig.dryRun) {
                return this._dryRunBuy(tokenMint, walletSource, dexType);
            }

            // ── Calculate SOL amount (8€ equivalent) ─────────────────────
            const solAmount = await this._calculateSolAmount(tradingConfig.buyAmountEur);
            if (solAmount <= 0) {
                logger.error({ component: 'Trading' }, 'Could not calculate SOL amount');
                return null;
            }

            // Check wallet balance
            const balance = await this._getWalletBalance();
            const actualSolAmount = Math.min(solAmount, Math.max(0, balance - 0.005)); // Keep 0.005 SOL for fees
            if (actualSolAmount <= 0) {
                logger.error({ component: 'Trading' }, 'Insufficient balance for auto-buy');
                await telegram.sendMessage(`⚠️ *Balance insuffisante*\nSolde: ${balance.toFixed(4)} SOL`);
                return null;
            }

            logger.info({ component: 'Trading', token: tokenMint, wallet: walletSource, dex: dexType }, `🎯 Auto-buy: ${tokenMint} | Amount: ${actualSolAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)`);

            // ── Get optimal priority fee ─────────────────────────────────
            const priorityFee = await this._getOptimalPriorityFee(tradingConfig.maxPriorityFeeEur);
            logger.debug({ component: 'Trading' }, `Priority fee: ${(priorityFee / 1e9).toFixed(6)} SOL`);

            // ── Create pending trade in DB ────────────────────────────────
            const trade = await db.createTrade({
                tokenAddress: tokenMint,
                walletSource,
                solSpent: actualSolAmount,
                eurSpent: tradingConfig.buyAmountEur,
                dexUsed: dexType,
                priorityFee: priorityFee / 1e9,
                amountTokens: '0',
                status: 'PENDING',
            });

            // ── Execute buy (cascade) ────────────────────────────────────
            let result = null;
            let actualDex = dexType;

            // Strategy 1: Pump.fun bonding curve (if token is on curve)
            if (dexType === 'pumpfun' || dexType === 'unknown') {
                try {
                    const { onCurve } = await pumpfun.isPumpFunToken(tokenMint);
                    if (onCurve) {
                        logger.info({ component: 'Trading', token: tokenMint }, '🟣 Attempting Pump.fun bonding curve buy...');
                        result = await pumpfun.buyOnBondingCurve(
                            tokenMint, actualSolAmount, this.wallet, this.connection, priorityFee
                        );
                        actualDex = 'pumpfun';
                    }
                } catch (err) {
                    logger.warn({ component: 'Trading', token: tokenMint }, `Pump.fun buy failed: ${err.message}`);
                }
            }

            // Strategy 2: Raydium/Jupiter (fallback or primary for Raydium tokens)
            if (!result) {
                try {
                    logger.info({ component: 'Trading', token: tokenMint }, '🔵 Attempting Raydium/Jupiter buy...');
                    result = await raydium.buyToken(
                        tokenMint, actualSolAmount, this.wallet, this.connection, priorityFee
                    );
                    actualDex = 'raydium';
                } catch (err) {
                    logger.error({ component: 'Trading', token: tokenMint }, `Raydium/Jupiter buy failed: ${err.message}`);
                    // Mark trade as failed
                    await db.closeTrade(trade.id, null, 0, 'BUY_FAILED');
                    await telegram.sendMessage(
                        `❌ *Achat Échoué*\n\n` +
                        `🪙 Token: \`${tokenMint}\`\n` +
                        `👤 Source: \`${walletSource.slice(0, 12)}...\`\n` +
                        `❗ ${err.message}`
                    );
                    return null;
                }
            }

            // ── Buy succeeded! ───────────────────────────────────────────
            const { txHash, tokensReceived, outputAmount } = result;
            const tokens = tokensReceived || outputAmount || '0';

            // Get immediate price
            const buyPrice = await this.getPrice(tokenMint);

            // Activate the trade
            await db.activateTrade(trade.id, txHash, buyPrice, tokens);

            // Get token info for alerts
            const tokenInfo = await this._getTokenInfo(tokenMint);

            logger.info({ component: 'Trading', token: tokenMint, symbol: tokenInfo.symbol, txHash }, `✅ Buy SUCCESS: ${tokenInfo.symbol} | TX: ${txHash}`);

            const liqStr = tokenInfo.liquidity > 0 ? `\n💧 Liquidité: $${tokenInfo.liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';
            const mcStr = tokenInfo.marketCap > 0 ? `\n💎 Market Cap: $${tokenInfo.marketCap.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';

            // Send Telegram alert
            await telegram.sendMessage(
                `🟢 *Achat Exécuté !*\n\n` +
                `🪙 *${tokenInfo.symbol}* (${tokenInfo.name})\n` +
                `📋 \`${tokenMint}\`\n` +
                `👤 Copié de: \`${walletSource.slice(0, 12)}...\`\n` +
                `💰 Montant: ${actualSolAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)\n` +
                `🏷️ DEX: ${actualDex}\n` +
                `💵 Prix: $${buyPrice.toFixed(10)}` +
                liqStr +
                mcStr +
                `\n🔗 [TX Solscan](https://solscan.io/tx/${txHash})\n` +
                `🎯 TP: +${tradingConfig.tpPercent}% | SL: ${tradingConfig.slPercent}%`
            );

            // Broadcast to WebSocket clients
            this._broadcast('trade:new', {
                id: trade.id,
                tokenAddress: tokenMint,
                tokenSymbol: tokenInfo.symbol,
                tokenName: tokenInfo.name,
                walletSource,
                buyTxHash: txHash,
                buyPriceUsd: buyPrice,
                solSpent: actualSolAmount,
                dexUsed: actualDex,
                status: 'OPEN',
            });

            // ── Record entry price T+5s ──────────────────────────────────
            this._recordEntryPrice(trade.id, tokenMint, tradingConfig.entryPriceDelaySec);

            return { tradeId: trade.id, txHash };

        } catch (err) {
            logger.error({ component: 'Trading', token: tokenMint }, `Auto-buy error: ${err.message}`, { stack: err.stack });
            return null;
        } finally {
            this._buyLock.delete(tokenMint);
        }
    }

    /**
     * Sell an open trade position.
     */
    async sellTrade(trade, reason = 'MANUAL') {
        if (!this.wallet) throw new Error('Wallet not configured');
        const tradingConfig = config.getTradingConfig();

        // ── LOCK CHECK ───────────────────────────────────────────────────
        if (this._sellLock.has(trade.id)) {
            logger.warn({ component: 'Trading', tradeId: trade.id }, `Sell already in progress for trade #${trade.id}, ignoring request.`);
            return null;
        }
        this._sellLock.add(trade.id);

        logger.logTrade(trade, `📤 Selling trade — Reason: ${reason}`);

        if (tradingConfig.dryRun) {
            this._sellLock.delete(trade.id);
            return this._dryRunSell(trade, reason);
        }

        try {
            await db.incrementSellAttempts(trade.id);
            await db.logTradeEvent(trade.id, 'INFO', `Démarrage vente (${reason})`);

            const quote = await this.getTokenQuote(trade.token_address);
            const sellPrice = quote.price;
            const priorityFee = await this._getOptimalPriorityFee(tradingConfig.maxPriorityFeeEur);

            let result = null;

            // Try Pump.fun sell first if bought on Pump.fun
            if (trade.dex_used === 'pumpfun') {
                try {
                    const { onCurve } = await pumpfun.isPumpFunToken(trade.token_address);
                    if (onCurve) {
                        result = await pumpfun.sellOnBondingCurve(
                            trade.token_address, trade.amount_tokens,
                            this.wallet, this.connection, priorityFee
                        );
                    }
                } catch (err) {
                    logger.warn({ component: 'Trading', tradeId: trade.id }, `Pump.fun sell failed, trying Jupiter: ${err.message}`);
                    await db.logTradeEvent(trade.id, 'ERROR', `Pump.fun sell failed: ${err.message}`);
                }
            }

            // Fallback to Jupiter
            if (!result) {
                try {
                    result = await raydium.sellToken(
                        trade.token_address, trade.amount_tokens,
                        this.wallet, this.connection, priorityFee
                    );
                } catch (err) {
                    await db.logTradeEvent(trade.id, 'ERROR', `Raydium/Jupiter sell failed: ${err.message}`);
                    throw err; // Re-throw to be caught by outer try/catch
                }
            }

            const { txHash } = result;
            await db.logTradeEvent(trade.id, 'TX_SENT', 'Transaction de vente envoyée', { txHash });

            // Close trade in DB
            await db.closeTrade(trade.id, txHash, sellPrice, reason);

            const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
            const pnlPct = entryPrice > 0
                ? ((sellPrice - entryPrice) / entryPrice * 100)
                : 0;
            const pnlStr = pnlPct >= 0 ? `+${pnlPct.toFixed(2)}%` : `${pnlPct.toFixed(2)}%`;

            const emoji = reason === 'TP' ? '💰' : reason === 'SL' ? '🛑' : '📤';
            const reasonText = reason === 'TP' ? 'Take Profit' : reason === 'SL' ? 'Stop Loss' : 'Manuel';

            const liqStr = quote.liquidity > 0 ? `\n💧 Liquidité: $${quote.liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';
            const mcStr = quote.marketCap > 0 ? `\n💎 Market Cap: $${quote.marketCap.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';

            await telegram.sendMessage(
                `${emoji} *${reasonText}*\n\n` +
                `🪙 Token: \`${trade.token_address}\`\n` +
                `📈 PnL: *${pnlStr}*\n` +
                `💵 Entrée: $${entryPrice.toFixed(10)}\n` +
                `💵 Sortie: $${sellPrice.toFixed(10)}\n` +
                `📊 ATH: $${(trade.ath_usd || 0).toFixed(10)}` +
                liqStr +
                mcStr +
                `\n🔗 [TX Solscan](https://solscan.io/tx/${txHash})`
            );

            this._broadcast('trade:closed', {
                id: trade.id,
                sellTxHash: txHash,
                sellPrice,
                pnlPct,
                reason,
            });

            logger.logTrade(trade, `✅ Sell SUCCESS: ${pnlStr} | Reason: ${reason}`, 'info', { sellPrice, pnlPct, txHash });
            return { txHash, pnlPct };

        } catch (err) {
            logger.error({ component: 'Trading', tradeId: trade.id }, `Sell failed: ${err.message}`, { stack: err.stack });
            await db.updateTradeError(trade.id, err.message);
            await telegram.sendMessage(
                `❌ *Vente Échouée*\n` +
                `Trade #${trade.id} | ${trade.token_address}\n` +
                `❗ ${err.message}`
            );
            return null;
        } finally {
            this._sellLock.delete(trade.id);
        }
    }

    /**
     * Fetch current USD price for a token.
     */
    async getPrice(tokenAddress) {
        const quote = await this.getTokenQuote(tokenAddress);
        return quote.price;
    }

    /**
     * Robust pricing engine with multi-source fallback and caching.
     * Returns { price, marketCap, liquidity, source }
     */
    async getTokenQuote(tokenAddress) {
        const now = Date.now();
        const priceCached = this._priceCache.get(tokenAddress);
        const metricsCached = this._metricsCache.get(tokenAddress);

        // TTL: 10s for price, 60s for metrics (MCap/Liq)
        const isPriceFresh = priceCached && (now - priceCached.ts < PRICE_CACHE_TTL_MS);
        const isMetricsFresh = metricsCached && (now - metricsCached.ts < 60_000);

        if (isPriceFresh && isMetricsFresh) {
            return {
                price: priceCached.price,
                marketCap: metricsCached.marketCap,
                liquidity: metricsCached.liquidity,
                source: metricsCached.source
            };
        }

        let price = priceCached?.price || 0;
        let marketCap = metricsCached?.marketCap || 0;
        let liquidity = metricsCached?.liquidity || 0;
        let source = metricsCached?.source || 'unknown';

        // --- Strategy 1: Jupiter (Raydium listed) ---
        try {
            const { data } = await axios.get(`https://api.jup.ag/price/v2?ids=${tokenAddress}`, { timeout: 3000 });
            const jupPrice = Number(data?.data?.[tokenAddress]?.price ?? 0);
            if (jupPrice > 0) {
                price = jupPrice;
                source = 'jupiter';
                this._priceCache.set(tokenAddress, { price, ts: now });
            }
        } catch (err) {
            logger.debug({ component: 'Trading', token: tokenAddress }, `Jupiter price fetch failed: ${err.message}`);
        }

        // --- Strategy 2: Pump.fun bonding curve ---
        if (price === 0 || !isMetricsFresh) {
            try {
                const curvePrice = await pumpfun.getBondingCurvePrice(tokenAddress);
                if (curvePrice && curvePrice.priceUsd > 0) {
                    if (price === 0) price = curvePrice.priceUsd;
                    marketCap = curvePrice.marketCap;
                    source = 'pumpfun';
                    this._priceCache.set(tokenAddress, { price, ts: now });
                    this._metricsCache.set(tokenAddress, { marketCap, liquidity: 0, source, ts: now });
                    if (price > 0 && marketCap > 0) return { price, marketCap, liquidity, source };
                }
            } catch (err) {
                logger.debug({ component: 'Trading', token: tokenAddress }, `Pump.fun quote failed: ${err.message}`);
            }
        }

        // --- Strategy 3: DexScreener (Fallback & Metrics) ---
        try {
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
            const pair = data?.pairs?.[0];
            if (pair) {
                if (price === 0) price = Number(pair.priceUsd || 0);
                marketCap = Number(pair.fdv || pair.marketCap || 0);
                liquidity = Number(pair.liquidity?.usd || 0);
                source = 'dexscreener';

                this._priceCache.set(tokenAddress, { price, ts: now });
                this._metricsCache.set(tokenAddress, { marketCap, liquidity, source, ts: now });
            }
        } catch (err) {
            logger.debug({ component: 'Trading', token: tokenAddress }, `DexScreener quote failed: ${err.message}`);
        }

        return { price, marketCap, liquidity, source };
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    _requireWallet() {
        if (!this.wallet) throw new Error('Wallet not configured — set SOLANA_PRIVATE_KEY in .env');
    }

    /**
     * Convert EUR amount to SOL using CoinGecko.
     */
    async _calculateSolAmount(eurAmount) {
        try {
            const solPriceEur = await this._getSolPriceEur();
            if (solPriceEur <= 0) return 0;
            const solAmount = eurAmount / solPriceEur;
            logger.info({ component: 'Trading' }, `${eurAmount}€ = ${solAmount.toFixed(6)} SOL (SOL/EUR: ${solPriceEur.toFixed(2)}€)`);
            return solAmount;
        } catch (err) {
            logger.error({ component: 'Trading' }, `EUR→SOL conversion failed: ${err.message}`);
            // Fallback to default
            const fallback = config.getTradingConfig().defaultBuyAmountSol;
            logger.warn({ component: 'Trading' }, `Using fallback: ${fallback} SOL`);
            return fallback;
        }
    }

    /**
     * Get SOL price in EUR from CoinGecko (cached 1 min).
     */
    async _getSolPriceEur() {
        if (this._solPriceEur && Date.now() - this._solPriceEur.ts < SOL_PRICE_CACHE_TTL_MS) {
            return this._solPriceEur.price;
        }
        const { data } = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=eur',
            { timeout: 5_000 }
        );
        const price = data?.solana?.eur ?? 0;
        this._solPriceEur = { price, ts: Date.now() };
        return price;
    }

    /**
     * Get wallet SOL balance.
     */
    async _getWalletBalance() {
        if (!this.wallet) return 0;
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey, 'confirmed');
            return balance / 1e9;
        } catch {
            return 0;
        }
    }

    /**
     * Get optimal priority fee from recent fees on the network.
     * Capped at maxFeeEur converted to lamports.
     */
    async _getOptimalPriorityFee(maxFeeEur) {
        try {
            // Get recent prioritization fees
            const { rpcUrl } = config.getHeliusConfig();
            const res = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1,
                    method: 'getRecentPrioritizationFees',
                    params: [],
                }),
                signal: AbortSignal.timeout(5_000),
            });
            const data = await res.json();
            const fees = data?.result ?? [];

            // Get the 75th percentile fee (aggressive but not max)
            if (fees.length === 0) return 50_000; // 0.00005 SOL default

            const sorted = fees
                .map(f => f.prioritizationFee)
                .filter(f => f > 0)
                .sort((a, b) => a - b);

            if (sorted.length === 0) return 50_000;

            const p75Index = Math.floor(sorted.length * 0.75);
            let optimalFee = sorted[p75Index] ?? 50_000;

            // Convert max fee EUR to lamports
            const solPriceEur = await this._getSolPriceEur();
            const maxFeeLamports = Math.floor((maxFeeEur / solPriceEur) * 1e9);

            // Cap the fee
            optimalFee = Math.min(optimalFee, maxFeeLamports);
            optimalFee = Math.max(optimalFee, 10_000); // Minimum 0.00001 SOL

            return optimalFee;

        } catch (err) {
            logger.warn({ component: 'Trading' }, `Priority fee fetch failed, using default: ${err.message}`);
            return 100_000; // 0.0001 SOL fallback
        }
    }

    /**
     * Get token metadata from DexScreener.
     */
    async _getTokenInfo(tokenAddress) {
        try {
            const { data } = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                { timeout: 5_000 }
            );
            const pair = data?.pairs?.[0];
            return {
                symbol: pair?.baseToken?.symbol ?? '???',
                name: pair?.baseToken?.name ?? 'Unknown',
                liquidity: pair?.liquidity?.usd ?? 0,
                marketCap: pair?.fdv ?? pair?.marketCap ?? 0,
            };
        } catch {
            return { symbol: '???', name: 'Unknown', liquidity: 0, marketCap: 0 };
        }
    }

    /**
     * Record entry price T+5s after buy confirmation (async, non-blocking).
     */
    async _recordEntryPrice(tradeId, tokenMint, delaySec) {
        // Fire and forget — don't block the buy flow
        setTimeout(async () => {
            try {
                const price = await this.getPrice(tokenMint);
                if (price > 0) {
                    await db.updateTradeEntryPrice(tradeId, price);
                    logger.info({ component: 'Trading', tradeId }, `📊 Entry price (T+${delaySec}s) recorded: $${price.toFixed(10)}`);

                    // Also initialize ATH with entry price
                    await db.updateTradeATH(tradeId, price);

                    // Update token info
                    const info = await this._getTokenInfo(tokenMint);
                    if (info.symbol !== '???') {
                        // We can update symbol/name in a future DB helper
                    }

                    this._broadcast('trade:entryPrice', {
                        id: tradeId,
                        entryPrice: price,
                    });
                }
            } catch (err) {
                logger.warn({ component: 'Trading', tradeId }, `Failed to record entry price: ${err.message}`);
            }
        }, delaySec * 1000);
    }

    /**
     * Dry-run mode: simulate a buy without executing.
     */
    async _dryRunBuy(tokenMint, walletSource, dexType) {
        const tradingConfig = config.getTradingConfig();
        const solAmount = await this._calculateSolAmount(tradingConfig.buyAmountEur);
        const price = await this.getPrice(tokenMint);
        const info = await this._getTokenInfo(tokenMint);

        logger.info({ component: 'Trading', token: tokenMint, dryRun: true }, `🧪 DRY RUN BUY: ${info.symbol} | Amount: ${solAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)`);

        // Create a trade record even in dry run
        const trade = await db.createTrade({
            tokenAddress: tokenMint,
            tokenSymbol: info.symbol,
            tokenName: info.name,
            walletSource,
            buyTxHash: 'DRY_RUN',
            buyPriceUsd: price,
            amountTokens: '0',
            solSpent: solAmount,
            eurSpent: tradingConfig.buyAmountEur,
            dexUsed: `${dexType}_dry`,
            status: 'OPEN',
        });

        await db.updateTradeEntryPrice(trade.id, price);
        await db.updateTradeATH(trade.id, price);

        const liqStr = info.liquidity > 0 ? `\n💧 Liquidité: $${info.liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';
        const mcStr = info.marketCap > 0 ? `\n💎 Market Cap: $${info.marketCap.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';

        await telegram.sendMessage(
            `🧪 *DRY RUN — Achat Simulé*\n\n` +
            `🪙 *${info.symbol}* (${info.name})\n` +
            `📋 \`${tokenMint}\`\n` +
            `👤 Copié de: \`${walletSource.slice(0, 12)}...\`\n` +
            `💰 Montant: ${solAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)\n` +
            `💵 Prix: $${price.toFixed(10)}` +
            liqStr +
            mcStr
        );

        return { tradeId: trade.id, txHash: 'DRY_RUN' };
    }

    /**
     * Dry-run sell.
     */
    async _dryRunSell(trade, reason) {
        const price = await this.getPrice(trade.token_address);
        const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
        const pnlPct = entryPrice > 0 ? ((price - entryPrice) / entryPrice * 100) : 0;
        const pnlStr = pnlPct >= 0 ? `+${pnlPct.toFixed(2)}%` : `${pnlPct.toFixed(2)}%`;

        logger.info({ component: 'Trading', tradeId: trade.id, dryRun: true }, `🧪 DRY RUN SELL: ${pnlStr} | Reason: ${reason}`);

        await db.closeTrade(trade.id, 'DRY_RUN', price, reason);

        const tokenInfo = await this._getTokenInfo(trade.token_address);
        const liqStr = tokenInfo.liquidity > 0 ? `\n💧 Liquidité: $${tokenInfo.liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';
        const mcStr = tokenInfo.marketCap > 0 ? `\n💎 Market Cap: $${tokenInfo.marketCap.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';

        const emoji = reason === 'TP' ? '💰' : reason === 'SL' ? '🛑' : '🧪';
        const reasonText = reason === 'TP' ? 'Take Profit (Simulé)' : reason === 'SL' ? 'Stop Loss (Simulé)' : 'Manuel (Simulé)';

        await telegram.sendMessage(
            `${emoji} *${reasonText}*\n\n` +
            `🪙 Token: \`${trade.token_address}\`\n` +
            `📈 PnL: *${pnlStr}*\n` +
            `💵 Entrée: $${entryPrice.toFixed(10)}\n` +
            `💵 Sortie: $${price.toFixed(10)}\n` +
            `📊 ATH: $${(trade.ath_usd || 0).toFixed(10)}` +
            liqStr +
            mcStr
        );

        return { txHash: 'DRY_RUN', pnlPct };
    }

    /**
     * Broadcast a message to all connected WebSocket clients.
     */
    _broadcast(type, data) {
        if (this.broadcast) {
            try {
                this.broadcast(JSON.stringify({ type, data, timestamp: Date.now() }));
            } catch (err) {
                // Silent fail — WS may not be connected
            }
        }
    }
}

module.exports = new TradingService();