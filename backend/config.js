'use strict';
require('dotenv').config();

let useBackup = false;

// ─── Helius Configuration ────────────────────────────────────────────────────

/**
 * Retourne la configuration active (primaire ou secours).
 */
function getHeliusConfig() {
    if (!useBackup || !process.env.HELIUS_API_KEY1) {
        return {
            apiKey: process.env.HELIUS_API_KEY,
            rpcUrl: process.env.RPC_URL,
            wssUrl: process.env.WSS_URL,
            txUrl: process.env.HELIUS_TRANSACTIONS_URL
        };
    } else {
        return {
            apiKey: process.env.HELIUS_API_KEY1,
            rpcUrl: process.env.RPC_URL1,
            wssUrl: process.env.WSS_URL1,
            txUrl: process.env.HELIUS_TRANSACTIONS_URL1
        };
    }
}

/**
 * Force le basculement sur la clé de secours.
 * @returns {boolean} true si le basculement a eu lieu
 */
function switchToBackup() {
    if (process.env.HELIUS_API_KEY1 && !useBackup) {
        useBackup = true;
        console.warn('\n[Config] ⚠️ QUOTA ATTEINT ! Basculement sur la clé Helius de secours (Backup 1).\n');
        return true;
    }
    return false;
}

// ─── Trading Configuration ───────────────────────────────────────────────────

function getTradingConfig() {
    return {
        buyAmountEur:       Number(process.env.BUY_AMOUNT_EUR ?? 8),
        maxPriorityFeeEur:  Number(process.env.MAX_PRIORITY_FEE_EUR ?? 1),
        slippageBps:        Number(process.env.SLIPPAGE_BPS ?? 8000),       // 80% — aggressive but with minimal protection
        tpPercent:          Number(process.env.TP_PERCENT ?? 100),          // +100% take profit
        slPercent:          Number(process.env.SL_PERCENT ?? -70),          // -70% stop loss
        entryPriceDelaySec: Number(process.env.ENTRY_PRICE_DELAY_SEC ?? 5),
        autoBuyEnabled:     (process.env.AUTO_BUY_ENABLED ?? 'true') === 'true',
        dryRun:             (process.env.DRY_RUN ?? 'false') === 'true',
        defaultBuyAmountSol: Number(process.env.DEFAULT_BUY_AMOUNT ?? 0.1),
    };
}

// ─── Pump.fun Program IDs ────────────────────────────────────────────────────

const PUMPFUN_PROGRAM_IDS = [
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',   // Pump.fun AMM
    'PumpkinsEq8xENVZE62QqojeZT6J9x5sHze1P5m4P6c',   // Pump.fun Classic
];

const RAYDIUM_PROGRAM_IDS = [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM v4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
];

const ALL_DEX_PROGRAMS = new Set([
    ...PUMPFUN_PROGRAM_IDS,
    ...RAYDIUM_PROGRAM_IDS,
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter v4
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
    'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',   // LaunchLab
]);

module.exports = {
    getHeliusConfig,
    switchToBackup,
    getTradingConfig,
    PUMPFUN_PROGRAM_IDS,
    RAYDIUM_PROGRAM_IDS,
    ALL_DEX_PROGRAMS,
};
