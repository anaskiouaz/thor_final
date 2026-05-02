'use strict';

const express = require('express');
const router = express.Router();
const config = require('../../config');
const trading = require('../../services/trading');

router.get('/', (_req, res) => {
    try {
        res.json({ 
            ...config.getTradingConfig(), 
            walletAddress: trading.wallet?.publicKey?.toString() ?? null 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/dryrun', (req, res) => {
    try {
        const { dryRun } = req.body;
        if (typeof dryRun !== 'boolean') {
            return res.status(400).json({ error: 'dryRun must be a boolean' });
        }
        config.setDryRun(dryRun);
        res.json({ success: true, dryRun });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/update', (req, res) => {
    try {
        config.updateTradingConfig(req.body);
        res.json({ success: true, config: config.getTradingConfig() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
