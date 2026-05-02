'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../services/database');

router.get('/recent', async (req, res) => {
    try {
        res.json(await db.getRecentTrades(parseInt(req.query.limit) || 10));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/open', async (_req, res) => {
    try {
        res.json(await db.getOpenTrades());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/stats', async (_req, res) => {
    try {
        res.json(await db.getTradeStats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
