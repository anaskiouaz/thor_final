const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'tracker.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Table for wallets to watch
    db.run(`CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT UNIQUE NOT NULL,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Table for detected token creations
    db.run(`CREATE TABLE IF NOT EXISTS detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT NOT NULL,
        token_address TEXT NOT NULL,
        tx_hash TEXT,
        block_number INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Table for tracking trades (positions)
    db.run(`CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT NOT NULL,
        buy_price REAL,
        amount REAL,
        sol_spent REAL,
        status TEXT DEFAULT 'OPEN',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

module.exports = {
    getWallets: () => {
        return new Promise((resolve, reject) => {
            db.all("SELECT * FROM wallets", [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },
    addWallet: (address, label) => {
        return new Promise((resolve, reject) => {
            db.run("INSERT INTO wallets (address, label) VALUES (?, ?)", [address, label], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, address, label });
            });
        });
    },
    deleteWallet: (id) => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM wallets WHERE id = ?", [id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },
    logDetection: (walletAddress, tokenAddress, txHash, blockNumber) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO detections (wallet_address, token_address, tx_hash, block_number) VALUES (?, ?, ?, ?)",
                [walletAddress, tokenAddress, txHash, blockNumber],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },
    getDetections: () => {
        return new Promise((resolve, reject) => {
            db.all("SELECT * FROM detections ORDER BY timestamp DESC LIMIT 100", [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },
    openPosition: (tokenAddress, buyPrice, amount, solSpent) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO positions (token_address, buy_price, amount, sol_spent) VALUES (?, ?, ?, ?)",
                [tokenAddress, buyPrice, amount, solSpent],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },
    getOpenPositions: () => {
        return new Promise((resolve, reject) => {
            db.all("SELECT * FROM positions WHERE status = 'OPEN'", [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },
    closePosition: (id) => {
        return new Promise((resolve, reject) => {
            db.run("UPDATE positions SET status = 'CLOSED' WHERE id = ?", [id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};
