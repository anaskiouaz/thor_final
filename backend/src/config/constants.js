'use strict';

module.exports = {
    // Solana Monitor settings
    MONITOR: {
        POLL_INTERVAL_MS: 10_000, // Reduced from 120s to 10s
        WALLET_DELAY_MS: 1000,
        TX_FETCH_DELAY_MS: 200,
        MAX_SIGS_PER_POLL: 10,
        MAX_PROCESSED_SIZE: 5000,
        CONCURRENCY_LIMIT: 5,
    },

    // AutoSell Engine settings
    AUTOSELL: {
        CHECK_INTERVAL_MS: 2000, // Reduced from 15s to 2s
        BATCH_SIZE: 5,
    },

    // Trading Service settings
    TRADING: {
        PRICE_CACHE_TTL_MS: 10000,
        METRICS_CACHE_TTL_MS: 60000,
        SOL_PRICE_CACHE_TTL_MS: 60000,
    }
};
