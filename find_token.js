
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'backend', 'tracker.db'));

db.get('SELECT token_address FROM detections WHERE type="purchase" ORDER BY timestamp DESC LIMIT 1', (err, row) => {
    if (row) console.log(row.token_address);
    else console.log('EPjFW36Cc5DfA7K3P68ePq891uJpUpHFnEBksTsJdqA');
    db.close();
});
