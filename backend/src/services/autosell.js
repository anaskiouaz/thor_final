'use strict';

const db = require('./database');
const trading = require('./trading');
const config = require('../config');
const telegram = require('./telegram');
const logger = require('../utils/logger');

const CHECK_INTERVAL_MS = 15_000;
const BATCH_SIZE = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AutoSellEngine {
    constructor() {
        this.isRunning = false;
        this.slBreaches = new Map();
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const tradingConfig = config.getTradingConfig();
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
                logger.error({ component: 'AutoSell' }, `Loop error: ${err.message}`);
            }
            await sleep(CHECK_INTERVAL_MS);
        }
    }

    async _checkOpenTrades() {
        const trades = await db.getOpenTrades();
        if (trades.length === 0) return;

        const tradingConfig = config.getTradingConfig();
        for (let i = 0; i < trades.length; i += BATCH_SIZE) {
            const batch = trades.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(trade => this._evaluateTrade(trade, tradingConfig)));
        }
    }

    async _evaluateTrade(trade, tradingConfig) {
        try {
            const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
            if (entryPrice <= 0) return;

            const currentPrice = await trading.getPrice(trade.token_address);
            if (currentPrice <= 0) return;

            const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
            await db.updateTradePrice(trade.id, currentPrice, pnlPct);

            if (currentPrice > (trade.ath_usd || 0)) {
                await db.updateTradeATH(trade.id, currentPrice);
                trading._broadcast('trade:ath', { id: trade.id, athUsd: currentPrice });
            }

            trading._broadcast('trade:price', { id: trade.id, currentPrice, pnlPct, athUsd: Math.max(currentPrice, trade.ath_usd || 0) });

            if (pnlPct >= tradingConfig.tpPercent) {
                logger.info({ component: 'AutoSell', tradeId: trade.id }, `💰 TP triggered: ${pnlPct.toFixed(2)}%`);
                await trading.sellTrade(trade, 'TP');
                return;
            }

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

        } catch (err) {
            logger.error({ component: 'AutoSell', tradeId: trade.id }, `Error evaluating trade: ${err.message}`);
        }
    }
}

module.exports = new AutoSellEngine();
