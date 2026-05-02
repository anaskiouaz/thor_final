'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = 'F:\\Development\\thor\\data\\tracker.db'; // Path from your logs

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    console.log('🧹 RADICAL CLEANUP starting on:', dbPath);
    db.run('DELETE FROM trades');
    db.run('DELETE FROM detections');
    db.run('DELETE FROM wallets');
    db.run('DELETE FROM audit_logs', (err) => {
        if (err) {
            console.warn('⚠️ Note: audit_logs table might not exist yet.');
        }
        console.log('✅ CLEANUP DONE. All simulation data removed.');
        db.close();
    });
});
