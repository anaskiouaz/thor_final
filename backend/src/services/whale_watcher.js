'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const db = require('./database');
const trading = require('./trading');
const telegram = require('./telegram');
const config = require('../config');
const logger = require('../utils/logger');
const { heliusRpc } = require('./monitor/rpc');

class WhaleWatcher {
    constructor() {
        this.positions = new Map(); // tokenAddress -> { holders: [], dumps: [] }
        this.isRunning = false;
        this.connection = null;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        const { rpcUrl } = config.getHeliusConfig();
        this.connection = new Connection(rpcUrl, 'confirmed');

        logger.info({ component: 'WhaleWatcher' }, '🐳 Starting Whale Watcher...');
        this._loop();
    }

    async _loop() {
        while (this.isRunning) {
            try {
                await this._checkOpenPositions();
            } catch (err) {
                logger.error({ component: 'WhaleWatcher' }, `⚠️ WhaleWatcher Error: ${err.message}`);
                // Security check: if RPC fails or getLargestAccounts fails, we wait longer to avoid spamming
                if (err.message.includes('getLargestAccounts') || err.message.includes('429')) {
                    logger.warn({ component: 'WhaleWatcher' }, '🐢 RPC Saturated. Waiting 30s before retry...');
                    await new Promise(r => setTimeout(r, 30_000));
                }
            }
            await new Promise(r => setTimeout(r, 60_000)); // Check every minute
        }
    }

    async _checkOpenPositions() {
        const trades = await db.getOpenTrades();
        const activeTokens = new Set(trades.map(t => t.token_address));

        // Clean up closed positions
        for (const token of this.positions.keys()) {
            if (!activeTokens.has(token)) this.positions.delete(token);
        }

        // Monitor new positions
        for (const trade of trades) {
            if (!this.positions.has(trade.token_address)) {
                await this._initPositionTracking(trade.token_address);
            }
            // Check activity for all open positions
            await this.checkWhaleActivity(trade.token_address);
        }
    }

    async _initPositionTracking(tokenAddress) {
        try {
            // Skip invalid or mock tokens
            if (!tokenAddress || tokenAddress.length < 32 || tokenAddress.includes('TEST_')) {
                return;
            }
            
            if (process.env.DRY_RUN === 'true' && (tokenAddress.startsWith('ThorX') || tokenAddress.startsWith('RugMe'))) {
                logger.info({ component: 'WhaleWatcher' }, `🧪 Simulation Token detected: ${tokenAddress.slice(0, 8)}... (Whale monitoring disabled)`);
                this.positions.set(tokenAddress, { holders: [], dumps: [], disabled: true });
                return;
            }
            
            logger.info({ component: 'WhaleWatcher' }, `🔍 Fetching top holders for ${tokenAddress.slice(0, 8)}...`);
            
            // Get top holders of the SPL token
            const result = await heliusRpc('getTokenLargestAccounts', [tokenAddress]);
            const largestAccounts = result?.value || [];
            
            if (!largestAccounts || largestAccounts.length === 0) {
                logger.warn({ component: 'WhaleWatcher' }, `⚠️ No holders found for ${tokenAddress.slice(0, 8)}`);
                return;
            }

            // We take top 10 holders
            const topHolders = largestAccounts.slice(0, 10).map(acc => ({
                address: acc.address,
                initialAmount: BigInt(acc.amount)
            }));

            this.positions.set(tokenAddress, {
                holders: topHolders,
                dumps: [] // List of { address, timestamp }
            });

            logger.info({ component: 'WhaleWatcher' }, `🐳 Tracking ${topHolders.length} whales for ${tokenAddress.slice(0, 8)}`);
        } catch (err) {
            if (err.message.includes('blocked') || err.message.includes('32600')) {
                logger.warn({ component: 'WhaleWatcher' }, `🚫 Whale monitoring skipped for ${tokenAddress.slice(0, 8)} (Method blocked by RPC)`);
                // Add a dummy entry to stop retrying
                this.positions.set(tokenAddress, { holders: [], dumps: [], disabled: true });
            } else {
                logger.error({ component: 'WhaleWatcher' }, `Failed to init whale tracking for ${tokenAddress}: ${err.message}`);
            }
        }
    }

    async checkWhaleActivity(tokenAddress) {
        const pos = this.positions.get(tokenAddress);
        if (!pos || pos.disabled) return;

        const tradingConfig = config.getTradingConfig();
        if (!tradingConfig.monitorWhales) return;

        try {
            const result = await heliusRpc('getTokenLargestAccounts', [tokenAddress]);
            const currentHolders = result?.value || [];
            const holderMap = new Map(currentHolders.map(h => [h.address, BigInt(h.amount)]));

            const now = Date.now();
            let dumpCount = 0;

            for (const whale of pos.holders) {
                const currentAmount = holderMap.get(whale.address) || 0n;
                if (whale.initialAmount === 0n) continue;

                const soldAmount = whale.initialAmount - currentAmount;
                const soldPct = (Number(soldAmount) / Number(whale.initialAmount)) * 100;

                if (soldPct >= tradingConfig.whaleDumpThreshold) {
                    // Whale dumped!
                    const dumpExists = pos.dumps.find(d => d.address === whale.address);
                    if (!dumpExists) {
                        pos.dumps.push({ address: whale.address, timestamp: now });
                        
                        await telegram.sendMessage(
                            `🐋 *ALERTE WHALE DUMP* 🐋\n\n` +
                            `🪙 Token: \`${tokenAddress}\`\n` +
                            `👤 Whale: \`${whale.address.slice(0, 12)}...\`\n` +
                            `📉 A vendu **${soldPct.toFixed(1)}%** de son bag !\n` +
                            `⚠️ Risque de crash imminent.`
                        );
                    }
                }
            }

            // Check if 3 whales dumped in 15 mins
            const recentDumps = pos.dumps.filter(d => (now - d.timestamp) < 15 * 60 * 1000);
            if (recentDumps.length >= 3 && tradingConfig.autoExitOnWhaleDump) {
                logger.warn({ component: 'WhaleWatcher' }, `🚨 3+ whales dumped ${tokenAddress}! Triggering panic exit.`);
                
                await telegram.sendMessage(
                    `🚨 *THOR EMERGENCY EXIT* 🚨\n\n` +
                    `😱 **3 BALEINES ONT DUMPÉ** dans les 15 dernières minutes.\n` +
                    `🔥 Sortie automatique de Stage 2 activée pour sécuriser les gains.`
                );

                const trades = await db.getOpenTrades();
                const trade = trades.find(t => t.token_address === tokenAddress);
                if (trade) {
                    await trading.sellTrade(trade, 'WHALE_DUMP', { amountPct: 50, stage: 2 });
                }
                
                // Clear dumps to avoid re-triggering immediately
                pos.dumps = [];
            }
        } catch (err) {
            logger.error({ component: 'WhaleWatcher' }, `Activity check failed for ${tokenAddress}: ${err.message}`);
        }
    }
}

module.exports = new WhaleWatcher();
