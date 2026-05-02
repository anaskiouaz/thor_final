'use strict';

const db = require('./database');
const trading = require('./trading');
const config = require('../config');
const telegram = require('./telegram');
const logger = require('../utils/logger');
const { AUTOSELL } = require('../config/constants');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AutoSellEngine {
    constructor() {
        this.isRunning = false;
        this.slBreaches = new Map();
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        logger.info({ component: 'AutoSell' }, '✅ Engine started');
        this._loop();
    }

    stop() {
        this.isRunning = false;
        logger.info({ component: 'AutoSell' }, '🛑 Engine stopped.');
    }

    async _loop() {
        while (this.isRunning) {
            try {
                await this._checkOpenTrades();
            } catch (err) {
                logger.error({ component: 'AutoSell' }, `Loop error: ${err.message}`, { stack: err.stack });
            }
            const tradingConfig = config.getTradingConfig();
            await sleep(tradingConfig.liquidityCheckInterval || AUTOSELL.CHECK_INTERVAL_MS);
        }
    }

    async _checkOpenTrades() {
        const trades = await db.getOpenTrades();
        if (trades.length === 0) return;

        const tradingConfig = config.getTradingConfig();
        for (let i = 0; i < trades.length; i += AUTOSELL.BATCH_SIZE) {
            const batch = trades.slice(i, i + AUTOSELL.BATCH_SIZE);
            await Promise.all(batch.map(trade => this._evaluateTrade(trade, tradingConfig)));
        }
    }

    async _evaluateTrade(trade, tradingConfig) {
        try {
            const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
            const entryLiquidity = trade.entry_liquidity || 0;
            if (entryPrice <= 0) return;

            const quote = await trading.getTokenQuote(trade.token_address);
            const currentPrice = quote.price;
            const currentLiquidity = quote.liquidity;
            
            if (currentPrice <= 0) return;

            const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
            await db.updateTradePrice(trade.id, currentPrice, pnlPct);
            await db.updateTradeLiquidity(trade.id, currentLiquidity);

            if (currentPrice > (trade.ath_usd || 0)) {
                await db.updateTradeATH(trade.id, currentPrice);
                trading._broadcast('trade:ath', { id: trade.id, athUsd: currentPrice });
            }

            trading._broadcast('trade:price', { id: trade.id, currentPrice, pnlPct, liquidity: currentLiquidity });

            // --- Liquidity Watch (Anti-Rug) ---
            if (entryLiquidity > 0 && currentLiquidity > 0) {
                const liqDropPct = ((entryLiquidity - currentLiquidity) / entryLiquidity) * 100;
                if (liqDropPct >= (tradingConfig.rugDropPercent || 40)) {
                    logger.error({ component: 'AutoSell', tradeId: trade.id }, `🚨 RUG DETECTED! Liquidity dropped by ${liqDropPct.toFixed(2)}% (Entry: ${entryLiquidity}, Current: ${currentLiquidity})`);
                    await telegram.sendMessage(
                        `🚨 *ALERTE RUG DÉTECTÉE* 🚨\n\n` +
                        `🪙 Token: \`${trade.token_address}\`\n` +
                        `📉 La liquidité a chuté de ${liqDropPct.toFixed(2)}% !\n` +
                        `🔥 Vente d'urgence déclenchée via Jito Bundle.`
                    );
                    await trading.sellTrade(trade, 'RUG_PANIC');
                    return;
                }
            }

            // --- Multi-Stage Take Profit (Moonbag Strategy) ---
            if (tradingConfig.enableStages) {
                // TP1: Secure investment (e.g. +50%)
                if (trade.current_stage === 0 && pnlPct >= tradingConfig.tp1Pnl) {
                    logger.info({ component: 'AutoSell', tradeId: trade.id }, `🚀 Stage 1 TP triggered: +${pnlPct.toFixed(2)}%`);
                    await trading.sellTrade(trade, 'TP1', { amountPct: tradingConfig.tp1SellPct, stage: 1 });
                    return;
                }

                // Break-Even protection after TP1
                // We use 1.0% buffer to cover fees (buy/sell/priority) and avoid loss
                if (trade.current_stage >= 1 && pnlPct <= 1.0) { 
                    logger.info({ component: 'AutoSell', tradeId: trade.id }, `🛡️ Break-Even triggered after TP1 (+${pnlPct.toFixed(2)}%)`);
                    await trading.sellTrade(trade, 'BE');
                    return;
                }

                // TP2: Profit take (e.g. +100%)
                if (trade.current_stage === 1 && pnlPct >= tradingConfig.tp2Pnl) {
                    logger.info({ component: 'AutoSell', tradeId: trade.id }, `🚀 Stage 2 TP triggered: +${pnlPct.toFixed(2)}%`);
                    await trading.sellTrade(trade, 'TP2', { amountPct: tradingConfig.tp2SellPct, stage: 2 });
                    return;
                }

                // Moonbag: Tight Trailing Stop for the rest (Stage 2+)
                if (trade.current_stage >= 2 && tradingConfig.trailingStopPercent > 0 && trade.ath_usd > 0) {
                    const dropFromAth = ((trade.ath_usd - currentPrice) / trade.ath_usd) * 100;
                    // Use a tighter trailing stop (half of config) for moonbag
                    const moonbagTrailingStop = tradingConfig.trailingStopPercent / 2;
                    if (dropFromAth >= moonbagTrailingStop && pnlPct > 0) {
                        logger.info({ component: 'AutoSell', tradeId: trade.id }, `📉 Moonbag Trailing SL triggered: -${dropFromAth.toFixed(2)}% from ATH`);
                        await trading.sellTrade(trade, 'MOON_EXIT');
                        return;
                    }
                }
            }

            // --- Traditional TP (if stages disabled or not yet reached Stage 1) ---
            if (!tradingConfig.enableStages && pnlPct >= tradingConfig.tpPercent) {
                logger.info({ component: 'AutoSell', tradeId: trade.id }, `💰 TP triggered: ${pnlPct.toFixed(2)}%`);
                await trading.sellTrade(trade, 'TP');
                return;
            }

            // --- Traditional SL ---
            if (pnlPct <= tradingConfig.slPercent) {
                const breachCount = (this.slBreaches.get(trade.id) || 0) + 1;
                this.slBreaches.set(trade.id, breachCount);
                if (breachCount >= 2) {
                    this.slBreaches.delete(trade.id);
                    await trading.sellTrade(trade, 'SL');
                    return;
                }
            } else {
                if (this.slBreaches.has(trade.id)) this.slBreaches.delete(trade.id);
            }

            // --- Traditional Trailing Stop Loss (for stage 0 or 1) ---
            if (!tradingConfig.enableStages || trade.current_stage < 2) {
                if (tradingConfig.trailingStopPercent > 0 && trade.ath_usd > 0) {
                    const dropFromAth = ((trade.ath_usd - currentPrice) / trade.ath_usd) * 100;
                    if (dropFromAth >= tradingConfig.trailingStopPercent && pnlPct > 10) { // Only if some profit
                        logger.info({ component: 'AutoSell', tradeId: trade.id }, `📉 Trailing SL triggered: -${dropFromAth.toFixed(2)}% from ATH`);
                        await trading.sellTrade(trade, 'TSL');
                        return;
                    }
                }
            }
        } catch (err) {
            logger.error({ component: 'AutoSell', tradeId: trade.id }, `Error evaluating trade: ${err.message}`, { stack: err.stack });
        }
    }
}

module.exports = new AutoSellEngine();
