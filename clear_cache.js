const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const databases = ['tracker.db', 'simulated.db'];

databases.forEach(dbName => {
    const dbPath = path.resolve(__dirname, 'data', dbName);
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error(`❌ Error opening ${dbName}:`, err.message);
            return;
        }
        
        db.run('DELETE FROM token_audits', (err) => {
            if (err) {
                if (err.message.includes('no such table')) {
                    console.warn(`ℹ️ Table token_audits does not exist yet in ${dbName}`);
                } else {
                    console.error(`❌ Error clearing ${dbName}:`, err.message);
                }
            } else {
                console.log(`✅ Cache ${dbName} vidé avec succès.`);
            }
            db.close();
        });
    });
});
