/**
 * autosell.js — Auto-sell engine with TP/SL + ATH tracking
 * Monitors all open positions and triggers sells based on profit targets.
 */

'use strict';

const db = require('./database');
const trading = require('./trading');
const config = require('./config');
const telegram = require('./telegram');

// ─── Constants ───────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 15_000;   // Check prices every 15s
const BATCH_SIZE = 5;               // Max concurrent price fetches

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns a formatted timestamp string for logs: [HH:MM:SS.mmm] */
function ts() {
    const now = new Date();
    return `[${now.toLocaleTimeString('fr-FR', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
}

// ─── AutoSellEngine ──────────────────────────────────────────────────────────

class AutoSellEngine {
    constructor() {
        this.isRunning = false;
    }

    /**
     * Start the auto-sell monitoring loop.
     */
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const tradingConfig = config.getTradingConfig();
        console.log(`${ts()} [AutoSell] ✅ Engine started`);
        console.log(`${ts()} [AutoSell]    TP: +${tradingConfig.tpPercent}% | SL: ${tradingConfig.slPercent}%`);
        console.log(`${ts()} [AutoSell]    Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
        console.log(`${ts()} [AutoSell]    Dry run: ${tradingConfig.dryRun ? 'YES' : 'NO'}`);

        this._loop();
    }

    /**
     * Stop the auto-sell engine.
     */
    stop() {
        this.isRunning = false;
        console.log(`${ts()} [AutoSell] 🛑 Engine stopped.`);
    }

    // ── Private ──────────────────────────────────────────────────────────────

    async _loop() {
        while (this.isRunning) {
            try {
                await this._checkOpenTrades();
            } catch (err) {
                console.error(`${ts()} [AutoSell] Loop error:`, err.message);
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
                console.warn(`${ts()} [AutoSell] ⚠️ No price for trade #${trade.id} (${trade.token_symbol || trade.token_address.slice(0, 8)}) — skipping`);
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
                console.log(`${ts()} [AutoSell] 💰 TP triggered for trade #${trade.id}: ${pnlPct.toFixed(2)}% >= +${tradingConfig.tpPercent}%`);
                await trading.sellTrade(trade, 'TP');
                return;
            }

            // ── Check Stop Loss ──────────────────────────────────────────
            if (pnlPct <= tradingConfig.slPercent) {
                console.log(`${ts()} [AutoSell] 🛑 SL triggered for trade #${trade.id}: ${pnlPct.toFixed(2)}% <= ${tradingConfig.slPercent}%`);
                await trading.sellTrade(trade, 'SL');
                return;
            }

            // Log position status (only for significant positions)
            if (Math.abs(pnlPct) > 10) {
                const emoji = pnlPct >= 0 ? '📈' : '📉';
                console.log(`${ts()} [AutoSell] ${emoji} Trade #${trade.id} ${trade.token_symbol || trade.token_address.slice(0, 8)}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | Price: $${currentPrice.toFixed(10)} | ATH: $${(Math.max(currentPrice, trade.ath_usd || 0)).toFixed(10)}`);
            }

        } catch (err) {
            console.error(`${ts()} [AutoSell] Error evaluating trade #${trade.id}:`, err.message);
        }
    }
}

module.exports = new AutoSellEngine();
