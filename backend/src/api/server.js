'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('../services/database');
const monitor = require('../services/monitor');
const autosell = require('../services/autosell');
const trading = require('../services/trading');
const heliometer = require('../services/heliometer');
const whaleWatcher = require('../services/whale_watcher');
const logger = require('../utils/logger');
const helius = require('../services/helius');

require('dotenv').config();

const PORT = process.env.PORT || 3000;

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// WebSocket Setup
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', data: { timestamp: Date.now() } }));
});

function broadcastWs(message) {
    for (const ws of wsClients) {
        if (ws.readyState === 1) {
            try { ws.send(message); } catch {}
        }
    }
}
trading.broadcast = broadcastWs;

// ─── Routes ──────────────────────────────────────────────────────────────────

const walletRoutes = require('./routes/wallets.routes');
const tradeRoutes = require('./routes/trades.routes');
const configRoutes = require('./routes/config.routes');

app.use('/api/wallets', walletRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/config', configRoutes);
app.use('/api/test', require('./routes/test.routes'));

// ─── Startup ─────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
    logger.info({ component: 'Server' }, `🚀 Thor v2 — http://0.0.0.0:${PORT}`);
    db.clearCorruptedAudits().catch(err => logger.error({ component: 'DB' }, `Failed to clear corrupted audits: ${err.message}`));
    heliometer.start();
    whaleWatcher.start();
    monitor.start();
    autosell.start();
});
