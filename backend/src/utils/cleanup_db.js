'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../../data/tracker.db');

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    console.log('🧹 Cleaning database tables...');
    db.run('DELETE FROM trades');
    db.run('DELETE FROM detections');
    db.run('DELETE FROM wallets');
    db.run('DELETE FROM audit_logs', (err) => {
        if (err) {
            console.error('❌ Error during cleanup:', err.message);
        } else {
            console.log('✅ Database cleaned successfully. No more ghost trades!');
        }
        db.close();
    });
});
