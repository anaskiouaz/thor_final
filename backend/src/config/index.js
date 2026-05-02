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

let overrides = {};

function getTradingConfig() {
    return {
        buyAmountEur:       overrides.buyAmountEur ?? Number(process.env.BUY_AMOUNT_EUR ?? 8),
        maxPriorityFeeEur:  overrides.maxPriorityFeeEur ?? Number(process.env.MAX_PRIORITY_FEE_EUR ?? 1),
        slippageBps:        overrides.slippageBps ?? Number(process.env.SLIPPAGE_BPS ?? 8000),       // 80% — aggressive but with minimal protection
        tpPercent:          overrides.tpPercent ?? Number(process.env.TP_PERCENT ?? 100),          // +100% take profit
        slPercent:          overrides.slPercent ?? Number(process.env.SL_PERCENT ?? -70),          // -70% stop loss
        entryPriceDelaySec: Number(process.env.ENTRY_PRICE_DELAY_SEC ?? 5),
        autoBuyEnabled:     overrides.autoBuyEnabled ?? (process.env.AUTO_BUY_ENABLED ?? 'true') === 'true',
        dryRun:             (process.env.DRY_RUN ?? 'false') === 'true',
        defaultBuyAmountSol: Number(process.env.DEFAULT_BUY_AMOUNT ?? 0.1),
        trailingStopPercent: Number(process.env.TRAILING_STOP_PERCENT ?? 5), // 5% trailing stop
        useJito:             (process.env.USE_JITO ?? 'false') === 'true',
        jitoTipSol:          Number(process.env.JITO_TIP_SOL ?? 0.001),
        priority_feeStrategy: process.env.PRIORITY_FEE_STRATEGY ?? 'aggressive', // aggressive, medium, safe
        maxRiskScore:       Number(process.env.MAX_RISK_SCORE ?? 500),
        blockMintAuthority: (process.env.BLOCK_MINT_AUTHORITY ?? 'true') === 'true',
        blockFreezeAuthority: (process.env.BLOCK_FREEZE_AUTHORITY ?? 'true') === 'true',
        maxTopHolderPct:      Number(process.env.MAX_TOP_HOLDER_PCT ?? 15),
        minLpBurnedPct:       Number(process.env.MIN_LP_BURNED_PCT ?? 95),
        blockMutableMetadata: (process.env.BLOCK_MUTABLE_METADATA ?? 'true') === 'true',
        minLiquidityUsd:      Number(process.env.MIN_LIQUIDITY_USD ?? 1000),
        rugPanicTipSol:       Number(process.env.RUG_PANIC_TIP_SOL ?? 0.005),
        rugDropPercent:       Number(process.env.RUG_DROP_PERCENT ?? 40),
        liquidityCheckInterval: Number(process.env.LIQUIDITY_CHECK_INTERVAL ?? 10000),
        minMomentumVolume:    Number(process.env.MIN_MOMENTUM_VOLUME ?? 10),
        enableStages: (process.env.ENABLE_STAGES ?? 'false') === 'true',
        tp1Pnl: Number(process.env.TP1_PNL ?? 50),
        tp1SellPct: Number(process.env.TP1_SELL_PCT ?? 50),
        tp2Pnl: Number(process.env.TP2_PNL ?? 100),
        tp2SellPct: Number(process.env.TP2_SELL_PCT ?? 25),
        monitorWhales: (process.env.MONITOR_WHALES ?? 'true') === 'true',
        whaleDumpThreshold: Number(process.env.WHALE_DUMP_THRESHOLD ?? 30),
        autoExitOnWhaleDump: (process.env.AUTO_EXIT_ON_WHALE_DUMP ?? 'true') === 'true',
        maxDailyLossSol: Number(process.env.MAX_DAILY_LOSS_SOL ?? 5.0), // Stop if loss exceeds 5 SOL/day
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

function setDryRun(value) {
    process.env.DRY_RUN = value === true ? 'true' : 'false';
}

function updateTradingConfig(newConfig) {
    if (newConfig.buyAmountEur !== undefined) overrides.buyAmountEur = Number(newConfig.buyAmountEur);
    if (newConfig.maxPriorityFeeEur !== undefined) overrides.maxPriorityFeeEur = Number(newConfig.maxPriorityFeeEur);
    if (newConfig.slippageBps !== undefined) overrides.slippageBps = Number(newConfig.slippageBps);
    if (newConfig.tpPercent !== undefined) overrides.tpPercent = Number(newConfig.tpPercent);
    if (newConfig.slPercent !== undefined) overrides.slPercent = Number(newConfig.slPercent);
    if (newConfig.autoBuyEnabled !== undefined) overrides.autoBuyEnabled = newConfig.autoBuyEnabled === true;
}

module.exports = {
    getHeliusConfig,
    switchToBackup,
    getTradingConfig,
    setDryRun,
    updateTradingConfig,
    PUMPFUN_PROGRAM_IDS,
    RAYDIUM_PROGRAM_IDS,
    ALL_DEX_PROGRAMS,
};
