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
require('dotenv').config();

// ─── Constants ───────────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_CACHE_TTL_MS = 10_000;   // 10s per token
const SOL_PRICE_CACHE_TTL_MS = 60_000; // 1 min for SOL/EUR price

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns a formatted timestamp string for logs: [HH:MM:SS.mmm] */
function ts() {
    const now = new Date();
    return `[${now.toLocaleTimeString('fr-FR', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
}

// ─── TradingService ──────────────────────────────────────────────────────────

class TradingService {
    constructor() {
        this.connection = new Connection(
            process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
            { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' }
        );
        this.wallet = null;
        this._priceCache = new Map();  // mint → { price, ts }
        this._solPriceEur = null;      // { price, ts }
        this._buyLock = new Set();     // prevent double-buys

        // WebSocket broadcast function (set by server.js)
        this.broadcast = null;

        if (process.env.SOLANA_PRIVATE_KEY) {
            try {
                const keyBytes = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
                this.wallet = Keypair.fromSecretKey(keyBytes);
                console.log(`${ts()} [Trading] ✅ Wallet loaded: ${this.wallet.publicKey.toString()}`);
            } catch (err) {
                console.error(`${ts()} [Trading] ❌ Invalid SOLANA_PRIVATE_KEY (must be base58 encoded):`, err.message);
            }
        } else {
            console.warn(`${ts()} [Trading] ⚠️ SOLANA_PRIVATE_KEY not set — auto-buy disabled.`);
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
            console.log(`${ts()} [Trading] Auto-buy disabled, skipping ${tokenMint}`);
            return null;
        }

        if (!this.wallet) {
            console.warn(`${ts()} [Trading] No wallet configured, skipping auto-buy`);
            return null;
        }

        // Prevent duplicate buys
        if (this._buyLock.has(tokenMint)) {
            console.log(`${ts()} [Trading] Already buying ${tokenMint}, skipping duplicate`);
            return null;
        }

        // Check if we already have an open trade for this token
        const hasOpen = await db.hasOpenTradeForToken(tokenMint);
        if (hasOpen) {
            console.log(`${ts()} [Trading] Already have open trade for ${tokenMint}, skipping`);
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
                console.error(`${ts()} [Trading] Could not calculate SOL amount`);
                return null;
            }

            // Check wallet balance
            const balance = await this._getWalletBalance();
            const actualSolAmount = Math.min(solAmount, Math.max(0, balance - 0.005)); // Keep 0.005 SOL for fees
            if (actualSolAmount <= 0) {
                console.error(`${ts()} [Trading] Insufficient balance`);
                await telegram.sendMessage(`⚠️ *Balance insuffisante*\nSolde: ${balance.toFixed(4)} SOL`);
                return null;
            }

            console.log(`${ts()} [Trading] 🎯 Auto-buy: ${tokenMint}`);
            console.log(`${ts()} [Trading]    Source wallet: ${walletSource.slice(0, 12)}...`);
            console.log(`${ts()} [Trading]    DEX: ${dexType} | Amount: ${actualSolAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)`);

            // ── Get optimal priority fee ─────────────────────────────────
            const priorityFee = await this._getOptimalPriorityFee(tradingConfig.maxPriorityFeeEur);
            console.log(`${ts()} [Trading]    Priority fee: ${(priorityFee / 1e9).toFixed(6)} SOL`);

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
                        console.log(`${ts()} [Trading] 🟣 Attempting Pump.fun bonding curve buy...`);
                        result = await pumpfun.buyOnBondingCurve(
                            tokenMint, actualSolAmount, this.wallet, this.connection, priorityFee
                        );
                        actualDex = 'pumpfun';
                    }
                } catch (err) {
                    console.warn(`${ts()} [Trading] Pump.fun buy failed: ${err.message}`);
                }
            }

            // Strategy 2: Raydium/Jupiter (fallback or primary for Raydium tokens)
            if (!result) {
                try {
                    console.log(`${ts()} [Trading] 🔵 Attempting Raydium/Jupiter buy...`);
                    result = await raydium.buyToken(
                        tokenMint, actualSolAmount, this.wallet, this.connection, priorityFee
                    );
                    actualDex = 'raydium';
                } catch (err) {
                    console.error(`${ts()} [Trading] Raydium/Jupiter buy failed: ${err.message}`);
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

            console.log(`${ts()} [Trading] ✅ Buy SUCCESS: ${tokenInfo.symbol} | TX: ${txHash}`);

            const liqStr = tokenInfo.liquidity > 0 ? `\n💧 Liquidité: $${tokenInfo.liquidity.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';
            const mcStr = tokenInfo.marketCap > 0 ? `\n💎 Market Cap: $${tokenInfo.marketCap.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';

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
            console.error(`${ts()} [Trading] Auto-buy error for ${tokenMint}:`, err.message);
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

        console.log(`${ts()} [Trading] 📤 Selling trade #${trade.id} (${trade.token_address}) — Reason: ${reason}`);

        if (tradingConfig.dryRun) {
            return this._dryRunSell(trade, reason);
        }

        try {
            const currentPrice = await this.getPrice(trade.token_address);
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
                    console.warn(`${ts()} [Trading] Pump.fun sell failed, trying Jupiter: ${err.message}`);
                }
            }

            // Fallback to Jupiter
            if (!result) {
                result = await raydium.sellToken(
                    trade.token_address, trade.amount_tokens,
                    this.wallet, this.connection, priorityFee
                );
            }

            const { txHash } = result;
            const sellPrice = await this.getPrice(trade.token_address);

            // Close trade in DB
            await db.closeTrade(trade.id, txHash, sellPrice, reason);

            const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
            const pnlPct = entryPrice > 0
                ? ((sellPrice - entryPrice) / entryPrice * 100)
                : 0;
            const pnlStr = pnlPct >= 0 ? `+${pnlPct.toFixed(2)}%` : `${pnlPct.toFixed(2)}%`;

            const emoji = reason === 'TP' ? '💰' : reason === 'SL' ? '🛑' : '📤';
            const reasonText = reason === 'TP' ? 'Take Profit' : reason === 'SL' ? 'Stop Loss' : 'Manuel';

            const tokenInfo = await this._getTokenInfo(trade.token_address);
            const liqStr = tokenInfo.liquidity > 0 ? `\n💧 Liquidité: $${tokenInfo.liquidity.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';
            const mcStr = tokenInfo.marketCap > 0 ? `\n💎 Market Cap: $${tokenInfo.marketCap.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';

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

            console.log(`${ts()} [Trading] ✅ Sell SUCCESS: #${trade.id} | ${pnlStr} | Reason: ${reason}`);
            return { txHash, pnlPct };

        } catch (err) {
            console.error(`${ts()} [Trading] Sell failed for trade #${trade.id}:`, err.message);
            await telegram.sendMessage(
                `❌ *Vente Échouée*\n` +
                `Trade #${trade.id} | ${trade.token_address}\n` +
                `❗ ${err.message}`
            );
            return null;
        }
    }

    /**
     * Fetch current USD price for a token via Jupiter Price API v2.
     */
    async getPrice(tokenAddress) {
        const cached = this._priceCache.get(tokenAddress);
        if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS) {
            return cached.price;
        }

        // Strategy 1: Jupiter Price API (works for Raydium-listed tokens)
        try {
            const { data } = await axios.get(
                `https://api.jup.ag/price/v2?ids=${tokenAddress}`,
                { timeout: 5_000 }
            );
            const price = Number(data?.data?.[tokenAddress]?.price ?? 0);
            if (price > 0) {
                this._priceCache.set(tokenAddress, { price, ts: Date.now() });
                return price;
            }
        } catch (err) {
            console.warn(`${ts()} [Trading] Jupiter price fetch failed:`, err.message);
        }

        // Strategy 2: Pump.fun bonding curve price (for tokens still on the curve)
        try {
            const curvePrice = await pumpfun.getBondingCurvePrice(tokenAddress);
            if (curvePrice && curvePrice.priceUsd > 0) {
                console.log(`${ts()} [Trading] 🟣 Using Pump.fun price for ${tokenAddress.slice(0, 8)}...: $${curvePrice.priceUsd.toFixed(12)}`);
                this._priceCache.set(tokenAddress, { price: curvePrice.priceUsd, ts: Date.now() });
                return curvePrice.priceUsd;
            }
        } catch (err) {
            console.warn(`${ts()} [Trading] Pump.fun price fetch failed:`, err.message);
        }

        // Strategy 3: DexScreener fallback
        try {
            const { data } = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                { timeout: 5_000 }
            );
            const price = Number(data?.pairs?.[0]?.priceUsd ?? 0);
            if (price > 0) {
                console.log(`${ts()} [Trading] 📊 Using DexScreener price for ${tokenAddress.slice(0, 8)}...: $${price.toFixed(12)}`);
                this._priceCache.set(tokenAddress, { price, ts: Date.now() });
                return price;
            }
        } catch (err) {
            console.warn(`${ts()} [Trading] DexScreener price fetch failed:`, err.message);
        }

        console.warn(`${ts()} [Trading] ⚠️ No price found for ${tokenAddress.slice(0, 8)}... from any source`);
        return 0;
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
            console.log(`${ts()} [Trading] ${eurAmount}€ = ${solAmount.toFixed(6)} SOL (SOL/EUR: ${solPriceEur.toFixed(2)}€)`);
            return solAmount;
        } catch (err) {
            console.error(`${ts()} [Trading] EUR→SOL conversion failed:`, err.message);
            // Fallback to default
            const fallback = config.getTradingConfig().defaultBuyAmountSol;
            console.warn(`${ts()} [Trading] Using fallback: ${fallback} SOL`);
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
            console.warn(`${ts()} [Trading] Priority fee fetch failed, using default:`, err.message);
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
                    console.log(`${ts()} [Trading] 📊 Entry price (T+${delaySec}s) for trade #${tradeId}: $${price.toFixed(10)}`);

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
                console.warn(`${ts()} [Trading] Failed to record entry price for trade #${tradeId}:`, err.message);
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

        console.log(`${ts()} [Trading] 🧪 DRY RUN BUY: ${info.symbol} (${tokenMint})`);
        console.log(`${ts()} [Trading]    Would spend: ${solAmount.toFixed(4)} SOL (~${tradingConfig.buyAmountEur}€)`);
        console.log(`${ts()} [Trading]    Current price: $${price.toFixed(10)}`);
        console.log(`${ts()} [Trading]    Source: ${walletSource}`);
        console.log(`${ts()} [Trading]    DEX: ${dexType}`);

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

        const liqStr = info.liquidity > 0 ? `\n💧 Liquidité: $${info.liquidity.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';
        const mcStr = info.marketCap > 0 ? `\n💎 Market Cap: $${info.marketCap.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';

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

        console.log(`${ts()} [Trading] 🧪 DRY RUN SELL: Trade #${trade.id} — ${reason} — PnL: ${pnlPct.toFixed(2)}%`);

        await db.closeTrade(trade.id, 'DRY_RUN', price, reason);

        const tokenInfo = await this._getTokenInfo(trade.token_address);
        const liqStr = tokenInfo.liquidity > 0 ? `\n💧 Liquidité: $${tokenInfo.liquidity.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';
        const mcStr = tokenInfo.marketCap > 0 ? `\n💎 Market Cap: $${tokenInfo.marketCap.toLocaleString('en-US', {maximumFractionDigits: 0})}` : '';

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