const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPaths = [
    'F:\\Development\\thor\\data\\tracker.db',
    'F:\\Development\\thor\\data\\simulated.db'
];

async function wipeDatabases() {
    for (const dbPath of dbPaths) {
        console.log(`Connecting to database at: ${dbPath}`);
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error(`Error opening database ${dbPath}:`, err.message);
                return;
            }
        });

        db.serialize(() => {
            db.run('DROP TABLE IF EXISTS token_audits;', (err) => {
                if (err) {
                    console.error(`Error dropping table in ${dbPath}:`, err.message);
                } else {
                    console.log(`Successfully dropped table 'token_audits' in ${dbPath}`);
                }
            });
        });

        db.close((err) => {
            if (err) {
                console.error(`Error closing database ${dbPath}:`, err.message);
            }
        });
    }
}

wipeDatabases();
