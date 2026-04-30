/**
 * autosell.js — Auto-sell engine with TP/SL + ATH tracking
 * Monitors all open positions and triggers sells based on profit targets.
 */

'use strict';

const db = require('./database');
const trading = require('./trading');
const config = require('./config');
const telegram = require('./telegram');
const logger = require('./lib/logger');

// ─── Constants ───────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 15_000;   // Check prices every 15s
const BATCH_SIZE = 5;               // Max concurrent price fetches

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// ─── AutoSellEngine ──────────────────────────────────────────────────────────

class AutoSellEngine {
    constructor() {
        this.isRunning = false;
        this.slBreaches = new Map(); // tradeId -> count
    }

    /**
     * Start the auto-sell monitoring loop.
     */
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const tradingConfig = config.getTradingConfig();
        logger.info({ component: 'AutoSell' }, '✅ Engine started');
        logger.info({ component: 'AutoSell' }, `TP: +${tradingConfig.tpPercent}% | SL: ${tradingConfig.slPercent}%`);
        logger.info({ component: 'AutoSell' }, `Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
        logger.info({ component: 'AutoSell' }, `Dry run: ${tradingConfig.dryRun ? 'YES' : 'NO'}`);

        this._loop();
    }

    /**
     * Stop the auto-sell engine.
     */
    stop() {
        this.isRunning = false;
        logger.info({ component: 'AutoSell' }, '🛑 Engine stopped.');
    }

    // ── Private ──────────────────────────────────────────────────────────────

    async _loop() {
        while (this.isRunning) {
            try {
                await this._checkOpenTrades();
            } catch (err) {
                logger.error({ component: 'AutoSell' }, `Loop error: ${err.message}`, { stack: err.stack });
            }
            await sleep(CHECK_INTERVAL_MS);
        }
    }

    /**
     * Check all open trades and apply TP/SL rules.
     */
    async _checkOpenTrades() {
        const trades = await db.getOpenTrades();
        if (trades.length === 0) return;

        const tradingConfig = config.getTradingConfig();

        // Process trades in batches
        for (let i = 0; i < trades.length; i += BATCH_SIZE) {
            const batch = trades.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(trade => this._evaluateTrade(trade, tradingConfig)));
        }
    }

    /**
     * Evaluate a single trade: update price, ATH, check TP/SL.
     */
    async _evaluateTrade(trade, tradingConfig) {
        try {
            // Skip trades without an entry price yet (still in PENDING or price not recorded)
            const entryPrice = trade.entry_price_usd || trade.buy_price_usd;
            if (entryPrice <= 0) {
                // Trade might be too new — entry price not recorded yet
                return;
            }

            // Get current price
            const currentPrice = await trading.getPrice(trade.token_address);
            if (currentPrice <= 0) {
                logger.warn({ component: 'AutoSell', tradeId: trade.id }, `⚠️ No price for trade #${trade.id} (${trade.token_symbol || trade.token_address.slice(0, 8)}) — skipping`);
                return;
            }

            // Calculate PnL
            const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

            // Update current price & PnL in DB
            await db.updateTradePrice(trade.id, currentPrice, pnlPct);

            // Update ATH if new high
            if (currentPrice > (trade.ath_usd || 0)) {
                await db.updateTradeATH(trade.id, currentPrice);
                // Broadcast ATH update
                trading._broadcast('trade:ath', {
                    id: trade.id,
                    athUsd: currentPrice,
                });
            }

            // Broadcast price update
            trading._broadcast('trade:price', {
                id: trade.id,
                currentPrice,
                pnlPct,
                athUsd: Math.max(currentPrice, trade.ath_usd || 0),
            });

            // ── Check Take Profit ────────────────────────────────────────
            if (pnlPct >= tradingConfig.tpPercent) {
                logger.info({ component: 'AutoSell', tradeId: trade.id }, `💰 TP triggered: ${pnlPct.toFixed(2)}% >= +${tradingConfig.tpPercent}%`);
                await trading.sellTrade(trade, 'TP');
                return;
            }

            // ── Check Stop Loss ──────────────────────────────────────────
            if (pnlPct <= tradingConfig.slPercent) {
                const breachCount = (this.slBreaches.get(trade.id) || 0) + 1;
                this.slBreaches.set(trade.id, breachCount);

                if (breachCount >= 2) {
                    logger.info({ component: 'AutoSell', tradeId: trade.id }, `🛑 SL confirmed (2/2): ${pnlPct.toFixed(2)}% <= ${tradingConfig.slPercent}%`);
                    this.slBreaches.delete(trade.id);
                    await trading.sellTrade(trade, 'SL');
                    return;
                } else {
                    logger.warn({ component: 'AutoSell', tradeId: trade.id }, `⚠️ SL alert (1/2): ${pnlPct.toFixed(2)}% — Awaiting confirmation...`);
                }
            } else {
                // Reset breach if price recovers
                if (this.slBreaches.has(trade.id)) {
                    logger.info({ component: 'AutoSell', tradeId: trade.id }, `✅ SL recovered for trade #${trade.id}`);
                    this.slBreaches.delete(trade.id);
                }
            }

            // Log position status (only for significant positions)
            if (Math.abs(pnlPct) > 10) {
                const emoji = pnlPct >= 0 ? '📈' : '📉';
                logger.info({ component: 'AutoSell', tradeId: trade.id }, `${emoji} ${trade.token_symbol || trade.token_address.slice(0, 8)}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | Price: $${currentPrice.toFixed(10)} | ATH: $${(Math.max(currentPrice, trade.ath_usd || 0)).toFixed(10)}`);
            }

        } catch (err) {
            logger.error({ component: 'AutoSell', tradeId: trade.id }, `Error evaluating trade: ${err.message}`, { stack: err.stack });
        }
    }
}

module.exports = new AutoSellEngine();
