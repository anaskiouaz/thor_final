'use strict';

const { Connection, Keypair } = require('@solana/web3.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const axios = require('axios');
const db = require('./database');
const telegram = require('./telegram');
const pumpfun = require('../core/pumpfun');
const raydium = require('../core/raydium');
const jupiter = require('../core/jupiter');
const jito = require('../core/jito');
const config = require('../config');
const logger = require('../utils/logger');
const security = require('./security');
const market = require('./market');
const cryptoUtils = require('../utils/crypto');
const { TRADING: TRADING_CONSTANTS } = require('../config/constants');
require('dotenv').config();

const Cache = require('../utils/Cache');

class TradingService {
    constructor() {
        const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
        if (rpcUrl && rpcUrl.startsWith('http')) {
            this.connection = new Connection(rpcUrl, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
        } else {
            logger.error({ component: 'Trading' }, `❌ RPC_URL invalide: ${rpcUrl}`);
        }
        this.wallet = null;
        this._priceCache = new Cache(TRADING_CONSTANTS.PRICE_CACHE_TTL_MS);
        this._metricsCache = new Cache(TRADING_CONSTANTS.METRICS_CACHE_TTL_MS);
        this._solPriceEur = null;
        this._buyLock = new Set();
        this._sellLock = new Set();
        this.broadcast = null;

        let privateKey = process.env.SOLANA_PRIVATE_KEY;
        const masterKey = process.env.MASTER_KEY;

        if (privateKey && privateKey.startsWith('enc:')) {
            if (!masterKey) {
                logger.error({ component: 'Trading' }, `❌ Private key is encrypted but MASTER_KEY is missing.`);
                privateKey = null;
            } else {
                try {
                    privateKey = cryptoUtils.decrypt(privateKey.slice(4), masterKey);
                    logger.info({ component: 'Trading' }, `🔐 Decrypted private key successfully.`);
                } catch (err) {
                    logger.error({ component: 'Trading', stack: err.stack }, `❌ Failed to decrypt private key: ${err.message}`);
                    privateKey = null;
                }
            }
        }

        if (privateKey) {
            try {
                const cleanKey = privateKey.replace(/[\s"']/g, '');
                if (cleanKey.startsWith('ey')) throw new Error("Format JWT/API Key détecté. Une clé Solana doit être en Base58.");
                
                const keyBytes = bs58.decode(cleanKey);
                this.wallet = Keypair.fromSecretKey(keyBytes);
                logger.info({ component: 'Trading' }, `✅ Wallet loaded: ${this.wallet.publicKey.toString()}`);
            } catch (err) {
                logger.error({ component: 'Trading', stack: err.stack }, `❌ ERREUR SOLANA_PRIVATE_KEY : ${err.message}. Vérifiez que votre clé dans le .env est correcte (Base58, pas d'espaces).`);
            }
        }

        // Fallback for Dry Run / Testing
        if (!this.wallet && process.env.DRY_RUN === 'true') {
            this.wallet = Keypair.generate();
            logger.warn({ component: 'Trading' }, `⚠️ No real wallet loaded. Using dummy wallet for DRY_RUN: ${this.wallet.publicKey.toString()}`);
        }

        if (!this.wallet) {
            logger.warn({ component: 'Trading' }, '⚠️ SOLANA_PRIVATE_KEY not set or decryption failed — auto-buy disabled.');
        }
    }

    async autoBuy(tokenMint, walletSource, dexType = 'unknown') {
        const tradingConfig = config.getTradingConfig();
        if (!tradingConfig.autoBuyEnabled) return null;
        if (!this.wallet) return null;
        if (this._buyLock.has(tokenMint)) return null;

        const dailyLossBreached = await this._checkDailyLoss();
        if (dailyLossBreached) {
            logger.warn({ component: 'Trading' }, `🛑 Auto-buy ignored: Daily loss limit reached.`);
            return null;
        }

        const hasOpen = await db.hasOpenTradeForToken(tokenMint);
        if (hasOpen) return null;

        this._buyLock.add(tokenMint);

        try {
            if (tradingConfig.dryRun) {
                return this._dryRunBuy(tokenMint, walletSource, dexType);
            }

            // ─── Rug-Guard & Honeypot Pre-check ──────────────────────────────────────
            const securityCheck = await security.checkToken(tokenMint);
            if (!securityCheck.isSafe) {
                await telegram.sendMessage(
                    `🚫 *Achat Annulé : Token Risqué*\n\n` +
                    `🪙 Token: \`${tokenMint}\`\n` +
                    `⚠️ Raisons: ${securityCheck.reasons.join(', ')}\n` +
                    `📊 Score RugCheck: ${securityCheck.score}`
                );
                return null;
            }

            // ─── Market Momentum Check ───────────────────────────────────────────────
            const momentum = await market.analyzeMomentum(tokenMint);
            if (!momentum.isGoodMomentum) {
                await telegram.sendMessage(
                    `📉 *Achat Ignoré : Momentum Faible*\n\n` +
                    `🪙 Token: \`${tokenMint}\`\n` +
                    `📊 Volume 5m: $${momentum.volume5m.toFixed(2)}\n` +
                    `🔄 Transactions 5m: ${momentum.txCount5m}\n` +
                    `💡 Seuil min: $${tradingConfig.minMomentumVolume}`
                );
                return null;
            }

            // ─── Direct Buy Sizing ──────────────────────────────────────────────────
            const buyAmountEur = tradingConfig.buyAmountEur;
            const useAggressivePriority = false;

            const solAmount = await this._calculateSolAmount(buyAmountEur);
            if (solAmount <= 0) return null;

            const balance = await this._getWalletBalance();
            const safeSolAmount = Math.min(solAmount, Math.max(0, balance - 0.005));
            if (safeSolAmount <= 0) {
                await telegram.sendMessage(`⚠️ *Balance insuffisante*\nSolde: ${balance.toFixed(4)} SOL (Requis: ${solAmount.toFixed(4)})`);
                return null;
            }

            const quote = await this.getTokenQuote(tokenMint);
            let priorityFee = await this._getOptimalPriorityFee(tradingConfig.maxPriorityFeeEur);
            if (useAggressivePriority) {
                priorityFee = Math.floor(priorityFee * 2);
                logger.info({ component: 'Trading' }, `🚀 Extreme Sentiment! Boosting priority fee to ${priorityFee}`);
            }

            const tokenInfo = await this._getTokenInfo(tokenMint);

            const trade = await db.createTrade({
                tokenAddress: tokenMint,
                walletSource,
                solSpent: safeSolAmount,
                eurSpent: buyAmountEur,
                dexUsed: dexType,
                priorityFee: priorityFee / 1e9,
                amountTokens: '0',
                entryLiquidity: quote.liquidity,
                status: 'PENDING',
            });

            let result = null;
            let actualDex = dexType;

            if (dexType === 'pumpfun' || dexType === 'unknown') {
                try {
                    const { onCurve, data: pumpData } = await pumpfun.isPumpFunToken(tokenMint);
                    if (onCurve) {
                        // Check Dev Activity
                        if (pumpData?.creator) {
                            const devDumping = await market.isDevDumping(tokenMint, pumpData.creator);
                            if (devDumping) {
                                await telegram.sendMessage(`⚠️ *Alerte Dev Dump* ⚠️\nLe créateur de \`${tokenInfo?.symbol}\` est en train de vendre ses jetons ! Achat risqué.`);
                            }
                        }
                        
                        result = await pumpfun.buyOnBondingCurve(tokenMint, safeSolAmount, this.wallet, this.connection, priorityFee);
                        actualDex = 'pumpfun';
                    }
                } catch (err) { logger.warn({ component: 'Trading', stack: err.stack }, `Pump.fun buy failed: ${err.message}`); }
            }

            if (!result) {
                try {
                    logger.info({ component: 'Trading' }, `Trying Jupiter for ${tokenMint}`);
                    result = await jupiter.buyToken(tokenMint, safeSolAmount, this.wallet, this.connection, priorityFee);
                    actualDex = 'jupiter';
                } catch (err) {
                    logger.warn({ component: 'Trading', stack: err.stack }, `Jupiter buy failed: ${err.message}`);
                    try {
                        result = await raydium.buyToken(tokenMint, safeSolAmount, this.wallet, this.connection, priorityFee);
                        actualDex = 'raydium';
                    } catch (err2) {
                        await db.closeTrade(trade.id, null, 0, 'BUY_FAILED');
                        await telegram.sendMessage(`❌ *Achat Échoué*\n🪙 Token: \`${tokenMint}\`\n❗ ${err2.message}`);
                        return null;
                    }
                }
            }

            const tokens = result.tokensReceived || result.outputAmount || '0';
            const buyPrice = await this.getPrice(tokenMint);
            await db.activateTrade(trade.id, result.txHash, buyPrice, tokens);

            await telegram.sendMessage(
                `🟢 *Achat Exécuté !*\n\n` +
                `🪙 *${tokenInfo.symbol}* (${tokenInfo.name})\n` +
                `💰 Montant: ${safeSolAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)\n` +
                `🏷️ DEX: ${actualDex}\n` +
                `💵 Prix: $${buyPrice.toFixed(10)}\n` +
                `🔗 [TX Solscan](https://solscan.io/tx/${result.txHash})`
            );

            this._recordEntryPrice(trade.id, tokenMint, tradingConfig.entryPriceDelaySec);

            await db.logAudit('BUY', 'TRADING', {
                tradeId: trade.id,
                token: tokenMint,
                amountSol: safeSolAmount,
                dex: actualDex,
                txHash: result.txHash
            });

            return { tradeId: trade.id, txHash: result.txHash };

        } catch (err) {
            logger.error({ component: 'Trading', stack: err.stack }, `Auto-buy error: ${err.message}`);
            return null;
        } finally {
            this._buyLock.delete(tokenMint);
        }
    }

    async _checkDailyLoss() {
        try {
            const tradingConfig = config.getTradingConfig();
            const dailyPnL = await db.getDailySolPnL();
            
            if (dailyPnL < -tradingConfig.maxDailyLossSol) {
                if (!this._lastLossAlert || Date.now() - this._lastLossAlert > 3600000) {
                    await telegram.sendMessage(
                        `🚨 *COUPE-CIRCUIT ACTIVÉ* 🚨\n\n` +
                        `📉 Perte quotidienne: ${dailyPnL.toFixed(4)} SOL\n` +
                        `🛑 Limite: ${tradingConfig.maxDailyLossSol} SOL\n\n` +
                        `Le bot a désactivé l'auto-buy pour protéger vos fonds.`
                    );
                    this._lastLossAlert = Date.now();
                }
                return true;
            }
            return false;
        } catch (err) {
            logger.error({ component: 'Trading', stack: err.stack }, `Error checking daily loss: ${err.message}`);
            return false;
        }
    }

    async sellTrade(trade, reason = 'MANUAL', options = {}) {
        if (!this.wallet) throw new Error('Wallet not configured');
        if (this._sellLock.has(trade.id)) return null;
        this._sellLock.add(trade.id);

        const tradingConfig = config.getTradingConfig();
        if (tradingConfig.dryRun) {
            this._sellLock.delete(trade.id);
            return this._dryRunSell(trade, reason);
        }

        const isPanic = reason === 'RUG_PANIC';
        const sellOptions = {
            forceJito: isPanic || options.forceJito,
            customTip: isPanic ? tradingConfig.rugPanicTipSol : options.customTip,
            ...options
        };

        try {
            await db.incrementSellAttempts(trade.id);
            const quote = await this.getTokenQuote(trade.token_address);
            const priorityFee = await this._getOptimalPriorityFee(tradingConfig.maxPriorityFeeEur);

            const totalTokens = trade.remaining_tokens || trade.amount_tokens;
            const amountToSell = options.amountPct 
                ? (BigInt(totalTokens) * BigInt(options.amountPct) / 100n).toString()
                : totalTokens;

            let result = null;
            if (trade.dex_used === 'pumpfun') {
                try {
                    const { onCurve } = await pumpfun.isPumpFunToken(trade.token_address);
                    if (onCurve) result = await pumpfun.sellOnBondingCurve(trade.token_address, amountToSell, this.wallet, this.connection, priorityFee, sellOptions);
                } catch (err) { logger.warn({ component: 'Trading', stack: err.stack }, `Pump.fun sell fallback: ${err.message}`); }
            }

            if (!result) {
                try {
                    result = await jupiter.sellToken(trade.token_address, amountToSell, this.wallet, this.connection, priorityFee, sellOptions);
                } catch (err) {
                    logger.warn({ component: 'Trading', stack: err.stack }, `Jupiter sell failed: ${err.message}`);
                    result = await raydium.sellToken(trade.token_address, amountToSell, this.wallet, this.connection, priorityFee);
                }
            }

            const solReceived = result.outputAmount ? Number(result.outputAmount) / 1e9 : 0;
            const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
            const pnlPct = entryPrice > 0 ? ((quote.price - entryPrice) / entryPrice * 100) : 0;

            if (options.amountPct && options.amountPct < 100) {
                const newRemaining = (BigInt(totalTokens) - BigInt(amountToSell)).toString();
                await db.updateTradeStage(trade.id, options.stage || (trade.current_stage + 1), newRemaining);
                
                let stageMsg = `💰 *Vente Partielle (${options.amountPct}%)*`;
                if (reason === 'TP1') stageMsg = `💰 *TP1 Exécuté* : ${options.amountPct}% vendu. Investissement sécurisé ! 🚀`;
                if (reason === 'TP2') stageMsg = `💰 *TP2 Exécuté* : ${options.amountPct}% vendu. Profit sécurisé ! 🌕`;

                await telegram.sendMessage(
                    `${stageMsg}\n\n` +
                    `🪙 Token: \`${trade.token_address}\`\n` +
                    `📈 PnL: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%*\n` +
                    `💵 Sortie: $${quote.price.toFixed(10)}\n` +
                    `🔗 [TX Solscan](https://solscan.io/tx/${result.txHash})`
                );
            } else {
                await db.closeTrade(trade.id, result.txHash, quote.price, reason, solReceived);
                
                let message = `${reason === 'TP' ? '💰' : '🛑'} *${reason}*`;
                if (reason === 'RUG_PANIC') message = `🚨 *CAPITAL SAUVÉ : Rug détecté*`;
                if (reason === 'MOON_EXIT') message = `🌙 *Moonbag Exited*`;
                if (reason === 'BE') message = `🛡️ *Break-Even Exited*`;

                await telegram.sendMessage(
                    message + `\n\n` +
                    `🪙 Token: \`${trade.token_address}\`\n` +
                    `📈 PnL: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%*\n` +
                    `💵 Entrée: $${entryPrice.toFixed(10)}\n` +
                    `💵 Sortie: $${quote.price.toFixed(10)}\n` +
                    `💰 Reçu: ${solReceived.toFixed(4)} SOL\n` +
                    `🔗 [TX Solscan](https://solscan.io/tx/${result.txHash})`
                );
            }

            this._broadcast('trade:closed', { id: trade.id, sellTxHash: result.txHash, sellPrice: quote.price, pnlPct, reason });

            return { txHash: result.txHash, pnlPct };

        } catch (err) {
            logger.error({ component: 'Trading', stack: err.stack }, `Sell failed: ${err.message}`);
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
        const priceCached = this._priceCache.get(tokenAddress);
        const metricsCached = this._metricsCache.get(tokenAddress);

        if (priceCached && metricsCached) {
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

        this._priceCache.set(tokenAddress, { price });
        this._metricsCache.set(tokenAddress, { marketCap, liquidity, source });
        return { price, marketCap, liquidity, source };
    }

    async _calculateSolAmount(eurAmount) {
        try {
            const solPriceEur = await this._getSolPriceEur();
            return solPriceEur > 0 ? eurAmount / solPriceEur : config.getTradingConfig().defaultBuyAmountSol;
        } catch (err) { return config.getTradingConfig().defaultBuyAmountSol; }
    }

    async _getSolPriceEur() {
        if (!this._solPriceCache) this._solPriceCache = new Cache(TRADING_CONSTANTS.SOL_PRICE_CACHE_TTL_MS);
        
        const cached = this._solPriceCache.get('sol_price');
        if (cached) return cached;

        const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=eur', { timeout: 5000 });
        const price = data?.solana?.eur ?? 0;
        this._solPriceCache.set('sol_price', price);
        return price;
    }

    async _getWalletBalance() {
        if (!this.wallet) return 0;
        try { return (await this.connection.getBalance(this.wallet.publicKey, 'confirmed')) / 1e9; } catch { return 0; }
    }

    async _getOptimalPriorityFee(maxFeeEur) {
        try {
            const tradingConfig = config.getTradingConfig();
            const helius = require('./helius'); // Local require to avoid circular dep if any
            
            const data = await helius.rpc('getRecentPrioritizationFees', []);
            const fees = data ?? [];
            if (fees.length === 0) return 50_000;

            const sorted = fees.map(f => f.prioritizationFee).filter(f => f > 0).sort((a, b) => a - b);
            if (sorted.length === 0) return 100_000;

            let percentile = 0.75; // Default (Medium)
            if (tradingConfig.priorityFeeStrategy === 'aggressive') percentile = 0.95;
            if (tradingConfig.priorityFeeStrategy === 'safe') percentile = 0.50;

            let optimalFee = sorted[Math.floor(sorted.length * percentile)] ?? 50_000;
            
            // Add a small multiplier for aggressive strategy
            if (tradingConfig.priorityFeeStrategy === 'aggressive') {
                optimalFee = Math.floor(optimalFee * 1.2);
            }

            const solPriceEur = await this._getSolPriceEur();
            const maxFeeLamports = Math.floor((maxFeeEur / solPriceEur) * 1e9);
            
            const finalFee = Math.max(10_000, Math.min(optimalFee, maxFeeLamports));
            logger.info({ component: 'Trading' }, `⚙️ Priority Fee (${tradingConfig.priorityFeeStrategy}): ${finalFee} lamports`);
            return finalFee;
        } catch (err) { 
            logger.warn({ component: 'Trading', stack: err.stack }, `Failed to get priority fees, using fallback: ${err.message}`);
            return 150_000; 
        }
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
        const quote = await this.getTokenQuote(tokenMint);
        const realPrice = quote.price;
        const price = realPrice * 1.015; // 1.5% realism malus
        const info = await this._getTokenInfo(tokenMint);
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
            entryLiquidity: quote.liquidity,
            status: 'OPEN' 
        });
        await db.updateTradeEntryPrice(trade.id, price);
        await db.updateTradeATH(trade.id, price);
        await telegram.sendMessage(`🧪 *DRY RUN — Achat Simulé*\n\n🪙 *${info.symbol}*\n💰 ${solAmount.toFixed(4)} SOL\n💵 Prix: $${price.toFixed(10)}`);
        
        await db.logAudit('BUY_DRY', 'TRADING', {
            tradeId: trade.id,
            token: tokenMint,
            amountSol: solAmount
        });

        return { tradeId: trade.id, txHash: 'DRY_RUN' };
    }

    async _dryRunSell(trade, reason) {
        const realPrice = await this.getPrice(trade.token_address);
        const price = realPrice * 0.985; // 1.5% realism malus
        const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
        const pnlPct = entryPrice > 0 ? ((price - entryPrice) / entryPrice * 100) : 0;
        
        const solReceived = trade.sol_spent * (1 + pnlPct / 100);
        await db.closeTrade(trade.id, 'DRY_RUN', price, reason, solReceived);
        
        await telegram.sendMessage(
            `🧪 *DRY RUN — Vente*\n` +
            `🪙 \`${trade.token_address}\`\n` +
            `📈 PnL: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%*\n` +
            `💰 Reçu (Simulé): ${solReceived.toFixed(4)} SOL`
        );
        
        await db.logAudit('SELL_DRY', 'TRADING', {
            tradeId: trade.id,
            token: trade.token_address,
            pnlPct: pnlPct,
            reason: reason
        });

        return { txHash: 'DRY_RUN', pnlPct };
    }

    _broadcast(type, data) { if (this.broadcast) this.broadcast(JSON.stringify({ type, data, timestamp: Date.now() })); }
}

module.exports = new TradingService();
