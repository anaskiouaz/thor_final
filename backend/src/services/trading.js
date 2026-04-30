'use strict';

const { Connection, Keypair } = require('@solana/web3.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const axios = require('axios');
const db = require('./database');
const telegram = require('./telegram');
const pumpfun = require('../core/pumpfun');
const raydium = require('../core/raydium');
const config = require('../config');
const logger = require('../utils/logger');
require('dotenv').config();

const PRICE_CACHE_TTL_MS = 10_000;
const SOL_PRICE_CACHE_TTL_MS = 60_000;

class TradingService {
    constructor() {
        const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
        if (rpcUrl && rpcUrl.startsWith('http')) {
            this.connection = new Connection(rpcUrl, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
        } else {
            logger.error({ component: 'Trading' }, `❌ RPC_URL invalide: ${rpcUrl}`);
        }
        this.wallet = null;
        this._priceCache = new Map();
        this._metricsCache = new Map();
        this._solPriceEur = null;
        this._buyLock = new Set();
        this._sellLock = new Set();
        this.broadcast = null;

        if (process.env.SOLANA_PRIVATE_KEY) {
            try {
                const keyBytes = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
                this.wallet = Keypair.fromSecretKey(keyBytes);
                logger.info({ component: 'Trading' }, `✅ Wallet loaded: ${this.wallet.publicKey.toString()}`);
            } catch (err) {
                logger.error({ component: 'Trading' }, `❌ Invalid SOLANA_PRIVATE_KEY: ${err.message}`);
            }
        } else {
            logger.warn({ component: 'Trading' }, '⚠️ SOLANA_PRIVATE_KEY not set — auto-buy disabled.');
        }
    }

    async autoBuy(tokenMint, walletSource, dexType = 'unknown') {
        const tradingConfig = config.getTradingConfig();
        if (!tradingConfig.autoBuyEnabled) return null;
        if (!this.wallet) return null;
        if (this._buyLock.has(tokenMint)) return null;

        const hasOpen = await db.hasOpenTradeForToken(tokenMint);
        if (hasOpen) return null;

        this._buyLock.add(tokenMint);

        try {
            if (tradingConfig.dryRun) {
                return this._dryRunBuy(tokenMint, walletSource, dexType);
            }

            const solAmount = await this._calculateSolAmount(tradingConfig.buyAmountEur);
            if (solAmount <= 0) return null;

            const balance = await this._getWalletBalance();
            const actualSolAmount = Math.min(solAmount, Math.max(0, balance - 0.005));
            if (actualSolAmount <= 0) {
                await telegram.sendMessage(`⚠️ *Balance insuffisante*\nSolde: ${balance.toFixed(4)} SOL`);
                return null;
            }

            const priorityFee = await this._getOptimalPriorityFee(tradingConfig.maxPriorityFeeEur);
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

            let result = null;
            let actualDex = dexType;

            if (dexType === 'pumpfun' || dexType === 'unknown') {
                try {
                    const { onCurve } = await pumpfun.isPumpFunToken(tokenMint);
                    if (onCurve) {
                        result = await pumpfun.buyOnBondingCurve(tokenMint, actualSolAmount, this.wallet, this.connection, priorityFee);
                        actualDex = 'pumpfun';
                    }
                } catch (err) { logger.warn({ component: 'Trading' }, `Pump.fun buy failed: ${err.message}`); }
            }

            if (!result) {
                try {
                    result = await raydium.buyToken(tokenMint, actualSolAmount, this.wallet, this.connection, priorityFee);
                    actualDex = 'raydium';
                } catch (err) {
                    await db.closeTrade(trade.id, null, 0, 'BUY_FAILED');
                    await telegram.sendMessage(`❌ *Achat Échoué*\n🪙 Token: \`${tokenMint}\`\n❗ ${err.message}`);
                    return null;
                }
            }

            const tokens = result.tokensReceived || result.outputAmount || '0';
            const buyPrice = await this.getPrice(tokenMint);
            await db.activateTrade(trade.id, result.txHash, buyPrice, tokens);

            const tokenInfo = await this._getTokenInfo(tokenMint);
            await telegram.sendMessage(
                `🟢 *Achat Exécuté !*\n\n` +
                `🪙 *${tokenInfo.symbol}* (${tokenInfo.name})\n` +
                `💰 Montant: ${actualSolAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)\n` +
                `🏷️ DEX: ${actualDex}\n` +
                `💵 Prix: $${buyPrice.toFixed(10)}\n` +
                `🔗 [TX Solscan](https://solscan.io/tx/${result.txHash})`
            );

            this._broadcast('trade:new', {
                id: trade.id, tokenAddress: tokenMint, tokenSymbol: tokenInfo.symbol,
                tokenName: tokenInfo.name, walletSource, buyTxHash: result.txHash,
                buyPriceUsd: buyPrice, solSpent: actualSolAmount, dexUsed: actualDex, status: 'OPEN',
            });

            this._recordEntryPrice(trade.id, tokenMint, tradingConfig.entryPriceDelaySec);
            return { tradeId: trade.id, txHash: result.txHash };

        } catch (err) {
            logger.error({ component: 'Trading' }, `Auto-buy error: ${err.message}`);
            return null;
        } finally {
            this._buyLock.delete(tokenMint);
        }
    }

    async sellTrade(trade, reason = 'MANUAL') {
        if (!this.wallet) throw new Error('Wallet not configured');
        if (this._sellLock.has(trade.id)) return null;
        this._sellLock.add(trade.id);

        const tradingConfig = config.getTradingConfig();
        if (tradingConfig.dryRun) {
            this._sellLock.delete(trade.id);
            return this._dryRunSell(trade, reason);
        }

        try {
            await db.incrementSellAttempts(trade.id);
            const quote = await this.getTokenQuote(trade.token_address);
            const priorityFee = await this._getOptimalPriorityFee(tradingConfig.maxPriorityFeeEur);

            let result = null;
            if (trade.dex_used === 'pumpfun') {
                try {
                    const { onCurve } = await pumpfun.isPumpFunToken(trade.token_address);
                    if (onCurve) result = await pumpfun.sellOnBondingCurve(trade.token_address, trade.amount_tokens, this.wallet, this.connection, priorityFee);
                } catch (err) { logger.warn({ component: 'Trading' }, `Pump.fun sell fallback: ${err.message}`); }
            }

            if (!result) {
                result = await raydium.sellToken(trade.token_address, trade.amount_tokens, this.wallet, this.connection, priorityFee);
            }

            await db.closeTrade(trade.id, result.txHash, quote.price, reason);
            const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
            const pnlPct = entryPrice > 0 ? ((quote.price - entryPrice) / entryPrice * 100) : 0;

            await telegram.sendMessage(
                `${reason === 'TP' ? '💰' : '🛑'} *${reason}*\n\n` +
                `🪙 Token: \`${trade.token_address}\`\n` +
                `📈 PnL: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%*\n` +
                `💵 Entrée: $${entryPrice.toFixed(10)}\n` +
                `💵 Sortie: $${quote.price.toFixed(10)}\n` +
                `🔗 [TX Solscan](https://solscan.io/tx/${result.txHash})`
            );

            this._broadcast('trade:closed', { id: trade.id, sellTxHash: result.txHash, sellPrice: quote.price, pnlPct, reason });
            return { txHash: result.txHash, pnlPct };

        } catch (err) {
            logger.error({ component: 'Trading' }, `Sell failed: ${err.message}`);
            await db.updateTradeError(trade.id, err.message);
            return null;
        } finally {
            this._sellLock.delete(trade.id);
        }
    }

    async getPrice(tokenAddress) {
        const quote = await this.getTokenQuote(tokenAddress);
        return quote.price;
    }

    async getTokenQuote(tokenAddress) {
        const now = Date.now();
        const priceCached = this._priceCache.get(tokenAddress);
        const metricsCached = this._metricsCache.get(tokenAddress);

        if (priceCached && (now - priceCached.ts < PRICE_CACHE_TTL_MS) && metricsCached && (now - metricsCached.ts < 60_000)) {
            return { price: priceCached.price, marketCap: metricsCached.marketCap, liquidity: metricsCached.liquidity, source: metricsCached.source };
        }

        let price = priceCached?.price || 0, marketCap = metricsCached?.marketCap || 0, liquidity = metricsCached?.liquidity || 0, source = 'unknown';

        try {
            const { data } = await axios.get(`https://api.jup.ag/price/v2?ids=${tokenAddress}`, { timeout: 3000 });
            if (data?.data?.[tokenAddress]?.price) { price = Number(data.data[tokenAddress].price); source = 'jupiter'; }
        } catch (err) {}

        if (price === 0 || metricsCached?.ts < now - 60_000) {
            try {
                const curvePrice = await pumpfun.getBondingCurvePrice(tokenAddress);
                if (curvePrice?.priceUsd > 0) {
                    if (price === 0) price = curvePrice.priceUsd;
                    marketCap = curvePrice.marketCap;
                    source = 'pumpfun';
                }
            } catch (err) {}
        }

        try {
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
            const pair = data?.pairs?.[0];
            if (pair) {
                if (price === 0) price = Number(pair.priceUsd || 0);
                marketCap = Number(pair.fdv || pair.marketCap || 0);
                liquidity = Number(pair.liquidity?.usd || 0);
                source = 'dexscreener';
            }
        } catch (err) {}

        this._priceCache.set(tokenAddress, { price, ts: now });
        this._metricsCache.set(tokenAddress, { marketCap, liquidity, source, ts: now });
        return { price, marketCap, liquidity, source };
    }

    async _calculateSolAmount(eurAmount) {
        try {
            const solPriceEur = await this._getSolPriceEur();
            return solPriceEur > 0 ? eurAmount / solPriceEur : config.getTradingConfig().defaultBuyAmountSol;
        } catch (err) { return config.getTradingConfig().defaultBuyAmountSol; }
    }

    async _getSolPriceEur() {
        if (this._solPriceEur && Date.now() - this._solPriceEur.ts < SOL_PRICE_CACHE_TTL_MS) return this._solPriceEur.price;
        const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=eur', { timeout: 5000 });
        const price = data?.solana?.eur ?? 0;
        this._solPriceEur = { price, ts: Date.now() };
        return price;
    }

    async _getWalletBalance() {
        if (!this.wallet) return 0;
        try { return (await this.connection.getBalance(this.wallet.publicKey, 'confirmed')) / 1e9; } catch { return 0; }
    }

    async _getOptimalPriorityFee(maxFeeEur) {
        try {
            const { rpcUrl } = config.getHeliusConfig();
            const res = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: [] }) });
            const data = await res.json();
            const fees = data?.result ?? [];
            if (fees.length === 0) return 50_000;
            const sorted = fees.map(f => f.prioritizationFee).filter(f => f > 0).sort((a, b) => a - b);
            let optimalFee = sorted[Math.floor(sorted.length * 0.75)] ?? 50_000;
            const solPriceEur = await this._getSolPriceEur();
            const maxFeeLamports = Math.floor((maxFeeEur / solPriceEur) * 1e9);
            return Math.max(10_000, Math.min(optimalFee, maxFeeLamports));
        } catch (err) { return 100_000; }
    }

    async _getTokenInfo(tokenAddress) {
        try {
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
            const pair = data?.pairs?.[0];
            return { symbol: pair?.baseToken?.symbol ?? '???', name: pair?.baseToken?.name ?? 'Unknown', liquidity: pair?.liquidity?.usd ?? 0, marketCap: pair?.fdv ?? pair?.marketCap ?? 0 };
        } catch { return { symbol: '???', name: 'Unknown', liquidity: 0, marketCap: 0 }; }
    }

    async _recordEntryPrice(tradeId, tokenMint, delaySec) {
        setTimeout(async () => {
            try {
                const price = await this.getPrice(tokenMint);
                if (price > 0) {
                    await db.updateTradeEntryPrice(tradeId, price);
                    await db.updateTradeATH(tradeId, price);
                    this._broadcast('trade:entryPrice', { id: tradeId, entryPrice: price });
                }
            } catch (err) {}
        }, delaySec * 1000);
    }

    async _dryRunBuy(tokenMint, walletSource, dexType) {
        const tradingConfig = config.getTradingConfig();
        const solAmount = await this._calculateSolAmount(tradingConfig.buyAmountEur);
        const price = await this.getPrice(tokenMint);
        const info = await this._getTokenInfo(tokenMint);
        const trade = await db.createTrade({ tokenAddress: tokenMint, tokenSymbol: info.symbol, tokenName: info.name, walletSource, buyTxHash: 'DRY_RUN', buyPriceUsd: price, amountTokens: '0', solSpent: solAmount, eurSpent: tradingConfig.buyAmountEur, dexUsed: `${dexType}_dry`, status: 'OPEN' });
        await db.updateTradeEntryPrice(trade.id, price);
        await db.updateTradeATH(trade.id, price);
        await telegram.sendMessage(`🧪 *DRY RUN — Achat Simulé*\n\n🪙 *${info.symbol}*\n💰 ${solAmount.toFixed(4)} SOL\n💵 Prix: $${price.toFixed(10)}`);
        return { tradeId: trade.id, txHash: 'DRY_RUN' };
    }

    async _dryRunSell(trade, reason) {
        const price = await this.getPrice(trade.token_address);
        const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
        const pnlPct = entryPrice > 0 ? ((price - entryPrice) / entryPrice * 100) : 0;
        await db.closeTrade(trade.id, 'DRY_RUN', price, reason);
        await telegram.sendMessage(`🧪 *DRY RUN — Vente*\n🪙 \`${trade.token_address}\`\n📈 PnL: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%*`);
        return { txHash: 'DRY_RUN', pnlPct };
    }

    _broadcast(type, data) { if (this.broadcast) this.broadcast(JSON.stringify({ type, data, timestamp: Date.now() })); }
}

module.exports = new TradingService();
