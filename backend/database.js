/**
 * database.js — SQLite persistence layer (Thor v2)
 * All methods return Promises. Schema is created/migrated on startup.
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./lib/logger');

const DB_PATH = path.resolve(__dirname, 'tracker.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) logger.error({ component: 'DB' }, `Failed to open database: ${err.message}`);
    else logger.info({ component: 'DB' }, `Database opened: ${DB_PATH}`);
});

// ─── Schema ───────────────────────────────────────────────────────────────────

db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');  // Better concurrent read performance

    db.run(`
        CREATE TABLE IF NOT EXISTS wallets (
            id         INTEGER  PRIMARY KEY AUTOINCREMENT,
            address    TEXT     UNIQUE NOT NULL,
            label      TEXT,
            chain      TEXT     DEFAULT 'solana',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS detections (
            id             INTEGER  PRIMARY KEY AUTOINCREMENT,
            wallet_address TEXT     NOT NULL,
            token_address  TEXT     NOT NULL,
            tx_hash        TEXT,
            block_number   INTEGER,
            type           TEXT     DEFAULT 'unknown',  -- 'mint' | 'purchase' | 'unknown'
            timestamp      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Index to speed up per-wallet queries
    db.run(`
        CREATE INDEX IF NOT EXISTS idx_detections_wallet
        ON detections (wallet_address, timestamp DESC)
    `);

    // Unique index for dedup on INSERT OR IGNORE
    db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_detections_dedup
        ON detections (wallet_address, token_address, tx_hash)
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS positions (
            id            INTEGER  PRIMARY KEY AUTOINCREMENT,
            token_address TEXT     NOT NULL,
            buy_price     REAL     DEFAULT 0,
            amount        TEXT     NOT NULL,   -- stored as TEXT to preserve large ints
            sol_spent     REAL     DEFAULT 0,
            status        TEXT     DEFAULT 'OPEN',
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            closed_at     DATETIME
        )
    `);

    // ── Trades table (Thor v2 — copy-trading) ────────────────────────────────
    db.run(`
        CREATE TABLE IF NOT EXISTS trades (
            id              INTEGER  PRIMARY KEY AUTOINCREMENT,
            token_address   TEXT     NOT NULL,
            token_symbol    TEXT,
            token_name      TEXT,
            wallet_source   TEXT     NOT NULL,
            buy_tx_hash     TEXT,
            buy_price_usd   REAL     DEFAULT 0,
            entry_price_usd REAL     DEFAULT 0,
            amount_tokens   TEXT     NOT NULL,
            sol_spent       REAL     DEFAULT 0,
            eur_spent       REAL     DEFAULT 0,
            ath_usd         REAL     DEFAULT 0,
            ath_timestamp   DATETIME,
            current_price   REAL     DEFAULT 0,
            pnl_pct         REAL     DEFAULT 0,
            sell_tx_hash    TEXT,
            sell_price_usd  REAL,
            sell_reason     TEXT,
            status          TEXT     DEFAULT 'PENDING',
            dex_used        TEXT,
            priority_fee         REAL     DEFAULT 0,
            last_error           TEXT,
            sell_attempts        INTEGER  DEFAULT 0,
            last_sell_attempt_at DATETIME,
            created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            closed_at            DATETIME
        )
    `);

    // ── Trade Events (Audit Log) ─────────────────────────────────────────────
    db.run(`
        CREATE TABLE IF NOT EXISTS trade_events (
            id         INTEGER  PRIMARY KEY AUTOINCREMENT,
            trade_id   INTEGER  NOT NULL,
            type       TEXT     NOT NULL, -- 'INFO', 'ERROR', 'TX_SENT', 'TX_CONFIRMED'
            msg        TEXT,
            meta       TEXT,              -- JSON string
            timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (trade_id) REFERENCES trades(id)
        )
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_trade_events_trade
        ON trade_events (trade_id, timestamp)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_trades_status
        ON trades (status, created_at DESC)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_trades_token
        ON trades (token_address, status)
    `);

    // Monitor: signatures already processed (to avoid re-fetching on restart)
    db.run(`
        CREATE TABLE IF NOT EXISTS processed_signatures (
            signature  TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Cleanup old signatures periodically (e.g. older than 7 days)
    db.run("DELETE FROM processed_signatures WHERE created_at < datetime('now', '-7 days')");

    // Cached tokens fetched per wallet (avoids re-fetching within 24h)
    db.run(`
        CREATE TABLE IF NOT EXISTS wallet_tokens (
            id             INTEGER  PRIMARY KEY AUTOINCREMENT,
            wallet_address TEXT     NOT NULL,
            mint           TEXT     NOT NULL,
            symbol         TEXT,
            name           TEXT,
            price_usd      TEXT,
            market_cap     TEXT,
            volume_24h     TEXT,
            liquidity      TEXT,
            dex_id         TEXT,
            source         TEXT,
            signature      TEXT,
            block_time     INTEGER,
            amount_out     TEXT,
            data_json      TEXT,                -- full enriched JSON for flexibility
            fetched_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(wallet_address, mint)         -- one row per wallet+mint, upsert
        )
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_wallet_tokens_wallet
        ON wallet_tokens (wallet_address, fetched_at DESC)
    `);

    // --- Migration: Add 'chain' to 'wallets' if missing ---
    db.all("PRAGMA table_info(wallets)", (err, rows) => {
        if (err) return logger.error({ component: 'DB' }, `Schema check failed: ${err.message}`);
        const hasChain = rows.some(r => r.name === 'chain');
        if (!hasChain) {
            logger.info({ component: 'DB' }, 'Migrating: Adding "chain" column to "wallets" table...');
            db.run("ALTER TABLE wallets ADD COLUMN chain TEXT DEFAULT 'solana'", (err) => {
                if (err) logger.error({ component: 'DB' }, `Migration failed: ${err.message}`);
                else logger.info({ component: 'DB' }, 'Migration successful: "chain" column added.');
            });
        }
    });

    // --- Migration: Add 'type' to 'detections' if missing ---
    db.all("PRAGMA table_info(detections)", (err, rows) => {
        if (err) return logger.error({ component: 'DB' }, `Schema check failed: ${err.message}`);
        const hasType = rows.some(r => r.name === 'type');
        if (!hasType) {
            logger.info({ component: 'DB' }, 'Migrating: Adding "type" column to "detections" table...');
            db.run("ALTER TABLE detections ADD COLUMN type TEXT DEFAULT 'unknown'", (err) => {
                if (err) logger.error({ component: 'DB' }, `Migration failed: ${err.message}`);
                else logger.info({ component: 'DB' }, 'Migration successful: "type" column added.');
            });
        }
    });

    // --- Migration: Add robustness columns to 'trades' if missing ---
    db.all("PRAGMA table_info(trades)", (err, rows) => {
        if (err) return logger.error({ component: 'DB' }, `Schema check failed: ${err.message}`);
        
        const colsToAdd = [
            { name: 'last_error', type: 'TEXT' },
            { name: 'sell_attempts', type: 'INTEGER DEFAULT 0' },
            { name: 'last_sell_attempt_at', type: 'DATETIME' }
        ];

        for (const col of colsToAdd) {
            if (!rows.some(r => r.name === col.name)) {
                logger.info({ component: 'DB' }, `Migrating: Adding "${col.name}" column to "trades" table...`);
                db.run(`ALTER TABLE trades ADD COLUMN ${col.name} ${col.type}`, (err) => {
                    if (err) logger.error({ component: 'DB' }, `Migration failed (${col.name}): ${err.message}`);
                    else logger.info({ component: 'DB' }, `Migration successful: "${col.name}" column added.`);
                });
            }
        }
    });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Wrap db.run in a Promise, resolving with `this` (lastID, changes). */
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

/** Wrap db.all in a Promise. */
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/** Wrap db.get in a Promise. */
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// ─── Wallets ─────────────────────────────────────────────────────────────────

function getWallets() {
    return all('SELECT * FROM wallets ORDER BY created_at DESC');
}

async function addWallet(address, label, chain = 'solana') {
    logger.info({ component: 'DB' }, `Ajout du wallet: ${address} (${label || 'Sans label'})`);
    const result = await run(
        'INSERT INTO wallets (address, label, chain) VALUES (?, ?, ?)',
        [address, label ?? null, chain]
    );
    return { id: result.lastID, address, label, chain };
}

function deleteWallet(id) {
    logger.info({ component: 'DB' }, `Suppression du wallet ID: ${id}`);
    return run('DELETE FROM wallets WHERE id = ?', [id]);
}

// ─── Detections ──────────────────────────────────────────────────────────────

function logDetection(walletAddress, tokenAddress, txHash, blockNumber, type = 'unknown') {
    logger.info({ component: 'DB' }, `Log détection: ${type} | Token: ${tokenAddress.slice(0, 8)}... | Wallet: ${walletAddress.slice(0, 8)}...`);
    return run(
        `INSERT OR IGNORE INTO detections (wallet_address, token_address, tx_hash, block_number, type)
         VALUES (?, ?, ?, ?, ?)`,
        [walletAddress, tokenAddress, txHash ?? null, blockNumber ?? null, type]
    );
}

function getDetections(limit = 100) {
    return all(
        'SELECT * FROM detections ORDER BY timestamp DESC LIMIT ?',
        [limit]
    );
}

function getDetectionsByWallet(address, limit = 10) {
    return all(
        'SELECT * FROM detections WHERE wallet_address = ? ORDER BY timestamp DESC LIMIT ?',
        [address, limit]
    );
}

async function hasTokenBeenDetected(tokenAddress) {
    const row = await get('SELECT 1 FROM detections WHERE token_address = ? LIMIT 1', [tokenAddress]);
    return !!row;
}

// ─── Positions (Legacy — kept for backward compat) ───────────────────────────

function openPosition(tokenAddress, buyPrice, amount, solSpent) {
    return run(
        `INSERT INTO positions (token_address, buy_price, amount, sol_spent)
         VALUES (?, ?, ?, ?)`,
        [tokenAddress, buyPrice, amount.toString(), solSpent]
    );
}

function getOpenPositions() {
    return all("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC");
}

function closePosition(id) {
    return run(
        "UPDATE positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [id]
    );
}

// ─── Trades (Thor v2) ────────────────────────────────────────────────────────

/**
 * Create a new trade record.
 * Status starts as 'PENDING' until the buy TX is confirmed, then moves to 'OPEN'.
 */
async function createTrade(data) {
    const result = await run(
        `INSERT INTO trades
         (token_address, token_symbol, token_name, wallet_source, buy_tx_hash,
          buy_price_usd, amount_tokens, sol_spent, eur_spent, dex_used, priority_fee, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.tokenAddress,
            data.tokenSymbol ?? '???',
            data.tokenName ?? 'Unknown',
            data.walletSource,
            data.buyTxHash ?? null,
            data.buyPriceUsd ?? 0,
            (data.amountTokens ?? '0').toString(),
            data.solSpent ?? 0,
            data.eurSpent ?? 0,
            data.dexUsed ?? 'unknown',
            data.priorityFee ?? 0,
            data.status ?? 'PENDING',
        ]
    );
    console.log(`[DB] Trade created #${result.lastID} — ${data.tokenSymbol ?? '???'} via ${data.dexUsed}`);
    return { id: result.lastID, ...data };
}

/**
 * Activate a trade (PENDING → OPEN) after buy TX confirmation.
 */
function activateTrade(id, buyTxHash, buyPriceUsd, amountTokens) {
    return run(
        `UPDATE trades SET status = 'OPEN', buy_tx_hash = ?, buy_price_usd = ?, amount_tokens = ?
         WHERE id = ?`,
        [buyTxHash, buyPriceUsd, amountTokens.toString(), id]
    );
}

/**
 * Set the entry price (recorded ~5s after buy confirmation).
 */
function updateTradeEntryPrice(id, entryPriceUsd) {
    return run(
        'UPDATE trades SET entry_price_usd = ? WHERE id = ?',
        [entryPriceUsd, id]
    );
}

/**
 * Update the ATH for a trade.
 */
function updateTradeATH(id, athUsd) {
    return run(
        'UPDATE trades SET ath_usd = ?, ath_timestamp = CURRENT_TIMESTAMP WHERE id = ? AND ? > ath_usd',
        [athUsd, id, athUsd]
    );
}

/**
 * Update current price and PnL percentage for a trade.
 */
function updateTradePrice(id, currentPrice, pnlPct) {
    return run(
        'UPDATE trades SET current_price = ?, pnl_pct = ? WHERE id = ?',
        [currentPrice, pnlPct, id]
    );
}

/**
 * Close a trade (sell executed).
 */
function closeTrade(id, sellTxHash, sellPriceUsd, reason) {
    return run(
        `UPDATE trades SET status = 'CLOSED', sell_tx_hash = ?, sell_price_usd = ?,
         sell_reason = ?, closed_at = CURRENT_TIMESTAMP,
         current_price = ?, pnl_pct = CASE
             WHEN entry_price_usd > 0 THEN ((? - entry_price_usd) / entry_price_usd) * 100
             ELSE 0
         END,
         last_error = NULL
         WHERE id = ?`,
        [sellTxHash, sellPriceUsd, reason, sellPriceUsd, sellPriceUsd, id]
    );
}

/**
 * Record an error or failed attempt for a trade.
 */
function updateTradeError(id, errorMsg) {
    return run(
        'UPDATE trades SET last_error = ?, status = CASE WHEN status = "PENDING" THEN "BUY_FAILED" ELSE status END WHERE id = ?',
        [errorMsg, id]
    );
}

/**
 * Increment sell attempts counter.
 */
function incrementSellAttempts(id) {
    return run(
        'UPDATE trades SET sell_attempts = sell_attempts + 1, last_sell_attempt_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id]
    );
}

/**
 * Log an audit event for a trade.
 */
function logTradeEvent(tradeId, type, msg, meta = null) {
    return run(
        'INSERT INTO trade_events (trade_id, type, msg, meta) VALUES (?, ?, ?, ?)',
        [tradeId, type, msg, meta ? JSON.stringify(meta) : null]
    );
}

/**
 * Get events for a trade.
 */
function getTradeEvents(tradeId) {
    return all('SELECT * FROM trade_events WHERE trade_id = ? ORDER BY timestamp DESC', [tradeId]);
}

/**
 * Get all open trades.
 */
function getOpenTrades() {
    return all("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY created_at ASC");
}

/**
 * Get most recent trades (for dashboard, all statuses).
 */
function getRecentTrades(limit = 10) {
    return all('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?', [limit]);
}

/**
 * Check if there's already an open trade for a given token.
 */
async function hasOpenTradeForToken(tokenAddress) {
    const row = await get(
        "SELECT 1 FROM trades WHERE token_address = ? AND status IN ('OPEN', 'PENDING')",
        [tokenAddress]
    );
    return !!row;
}

/**
 * Get trade by ID.
 */
function getTradeById(id) {
    return get('SELECT * FROM trades WHERE id = ?', [id]);
}

/**
 * Get trade statistics.
 */
async function getTradeStats() {
    const total = await get('SELECT COUNT(*) as count FROM trades');
    const open = await get("SELECT COUNT(*) as count FROM trades WHERE status = 'OPEN'");
    const closed = await get("SELECT COUNT(*) as count FROM trades WHERE status = 'CLOSED'");
    const wins = await get("SELECT COUNT(*) as count FROM trades WHERE status = 'CLOSED' AND sell_reason = 'TP'");
    const totalPnl = await get("SELECT SUM(CASE WHEN status = 'CLOSED' THEN (sell_price_usd - entry_price_usd) * CAST(amount_tokens AS REAL) ELSE 0 END) as total FROM trades");
    const totalSolSpent = await get("SELECT SUM(sol_spent) as total FROM trades");

    return {
        totalTrades: total?.count ?? 0,
        openTrades: open?.count ?? 0,
        closedTrades: closed?.count ?? 0,
        wins: wins?.count ?? 0,
        winRate: closed?.count > 0 ? ((wins?.count ?? 0) / closed.count * 100).toFixed(1) : '0.0',
        totalPnlUsd: totalPnl?.total ?? 0,
        totalSolSpent: totalSolSpent?.total ?? 0,
    };
}

// ─── Wallet Token Cache ──────────────────────────────────────────────────────

/**
 * Check if the cached tokens for a wallet are still fresh (<maxAgeMs).
 * Returns the cached rows if fresh, or null if stale/missing.
 */
async function getCachedWalletTokens(walletAddress, maxAgeMs = 24 * 60 * 60 * 1000) {
    const rows = await all(
        'SELECT * FROM wallet_tokens WHERE wallet_address = ? ORDER BY fetched_at DESC',
        [walletAddress]
    );
    if (rows.length === 0) {
        logger.debug({ component: 'DB Cache' }, `Aucun token trouvé pour ${walletAddress}`);
        return null;
    }

    // SQLite current_timestamp is UTC. fetched_at is something like "2024-04-27 18:00:00"
    // Normalize to ISO for better parsing: replace space with T
    const dbDateStr = rows[0].fetched_at.replace(' ', 'T') + 'Z';
    const newest = new Date(dbDateStr).getTime();
    const age = Date.now() - newest;

    if (age > maxAgeMs) {
        logger.debug({ component: 'DB Cache' }, `Cache trop vieux pour ${walletAddress} (${Math.round(age / 1000 / 60)} min)`);
        return null;
    }

    // Parse data_json back into objects
    return rows.map(r => {
        try { return JSON.parse(r.data_json); }
        catch { return { mint: r.mint, symbol: r.symbol, name: r.name }; }
    });
}

/**
 * Save enriched tokens to the DB cache.
 * Uses INSERT OR REPLACE to upsert (update if wallet+mint already exists).
 */
async function saveWalletTokens(walletAddress, enrichedTokens) {
    logger.debug({ component: 'DB Cache' }, `Mise en cache de ${enrichedTokens.length} tokens pour ${walletAddress}`);
    for (const t of enrichedTokens) {
        await run(
            `INSERT OR REPLACE INTO wallet_tokens
             (wallet_address, mint, symbol, name, price_usd, market_cap, volume_24h,
              liquidity, dex_id, source, signature, block_time, amount_out, data_json, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                walletAddress,
                t.mint ?? '',
                t.symbol ?? '???',
                t.name ?? 'Unknown',
                t.priceUsd ?? null,
                t.marketCap ?? null,
                t.volume24h ?? null,
                t.liquidity ?? null,
                t.dexId ?? null,
                t.source ?? null,
                t.signature ?? null,
                t.blockTime ?? null,
                t.amountOut?.toString() ?? null,
                JSON.stringify(t),
            ]
        );
    }
}

/** Delete cached tokens for a wallet (used on manual refresh). */
function clearWalletTokenCache(walletAddress) {
    return run('DELETE FROM wallet_tokens WHERE wallet_address = ?', [walletAddress]);
}

// ─── Monitor Signatures ──────────────────────────────────────────────────────

async function isSignatureProcessed(signature) {
    const row = await all('SELECT 1 FROM processed_signatures WHERE signature = ?', [signature]);
    return row.length > 0;
}

function markSignatureProcessed(signature) {
    return run('INSERT OR IGNORE INTO processed_signatures (signature) VALUES (?)', [signature]);
}

async function getRecentProcessedSignatures(limit = 1000) {
    const rows = await all('SELECT signature FROM processed_signatures ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map(r => r.signature);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    // Wallets
    getWallets,
    addWallet,
    deleteWallet,

    // Detections
    logDetection,
    getDetections,
    getDetectionsByWallet,
    hasTokenBeenDetected,

    // Positions (legacy)
    openPosition,
    getOpenPositions,
    closePosition,

    // Trades (v2)
    createTrade,
    activateTrade,
    updateTradeEntryPrice,
    updateTradeATH,
    updateTradePrice,
    closeTrade,
    getOpenTrades,
    getRecentTrades,
    hasOpenTradeForToken,
    getTradeById,
    getTradeStats,
    updateTradeError,
    incrementSellAttempts,
    logTradeEvent,
    getTradeEvents,

    // Wallet Token Cache
    getCachedWalletTokens,
    saveWalletTokens,
    clearWalletTokenCache,

    // Monitor
    isSignatureProcessed,
    markSignatureProcessed,
    getRecentProcessedSignatures,
};