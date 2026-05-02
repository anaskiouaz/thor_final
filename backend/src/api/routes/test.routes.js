'use strict';

const express = require('express');
const router = express.Router();
const monitor = require('../../services/monitor');
const logger = require('../../utils/logger');

/**
 * Trigger a fake detection for testing purposes
 * POST /api/test/trigger
 * Body: { tokenMint, walletAddress, type }
 */
router.post('/trigger', async (req, res) => {
    const { tokenMint, walletAddress, type = 'purchase' } = req.body;
    
    if (!tokenMint || !walletAddress) {
        return res.status(400).json({ error: 'Missing tokenMint or walletAddress' });
    }

    logger.info({ component: 'TestAPI' }, `🧪 Triggering fake detection for ${tokenMint} from ${walletAddress}`);
    
    try {
        const wallet = monitor.walletData ? monitor.walletData.get(walletAddress) : null;
        
        // 1. Trigger Auto-Buy (Async)
        // We use the monitor's trigger method directly
        setImmediate(() => {
            monitor._triggerAutoBuy(tokenMint, walletAddress, 'jupiter');
        });

        res.json({ success: true, message: 'Detection triggered and Auto-Buy scheduled' });
    } catch (err) {
        logger.error({ component: 'TestAPI' }, `Error in test trigger: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
