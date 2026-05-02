'use strict';

/**
 * simulate.js — Test simulator for Thor V2
 * Use this to trigger fake events and test the bot's logic (Multi-copy, Rug-Guard, TP, etc.)
 */

const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const API_URL = 'http://localhost:3000'; // Your backend API
const SCENARIO = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1] || process.argv[3] || 'help';

const MOCK_TOKENS = {
    SOL: 'So11111111111111111111111111111111111111112',
    TOKEN_X: 'ThorX11111111111111111111111111111111111111', // Valid Base58 format
    RUG_TOKEN: 'RugMe1111111111111111111111111111111111111'
};

const MOCK_WALLETS = [
    { address: 'Alpha1111111111111111111111111111111111111', label: 'Alpha One' },
    { address: 'Alpha2222222222222222222222222222222222222', label: 'Alpha Two' },
    { address: 'Alpha3333333333333333333333333333333333333', label: 'Alpha Three' }
];

async function run() {
    console.log(`🚀 Starting Thor Simulator — Scenario: ${SCENARIO.toUpperCase()}`);

    switch (SCENARIO) {
        case 'multi-copy':
            await runMultiCopyTest();
            break;
        case 'rug':
            await runRugTest();
            break;
        case 'tp':
            await runTPTest();
            break;
        case 'help':
        default:
            showHelp();
            break;
    }
}

/**
 * Scenario: Multi-Copy
 * Trigger multiple buys for the same token from different wallets.
 */
async function runMultiCopyTest() {
    console.log('--- Scenario: Multi-Copy ---');
    const token = MOCK_TOKENS.TOKEN_X;

    // 0. Ensure wallets are registered
    console.log('Ensuring mock wallets are registered...');
    for (const wallet of MOCK_WALLETS) {
        try {
            await axios.post(`${API_URL}/api/wallets`, {
                address: wallet.address,
                label: wallet.label
            });
        } catch (err) {
            // Ignore if already exists
        }
    }

    for (let i = 0; i < 3; i++) {
        const wallet = MOCK_WALLETS[i];
        console.log(`[${i+1}/3] Simulating buy from ${wallet.label}...`);
        
        try {
            const res = await axios.post(`${API_URL}/api/test/trigger`, {
                tokenMint: token,
                walletAddress: wallet.address
            });
            console.log(` ✅ Detection triggered: ${res.data.message}`);
        } catch (err) {
            console.error(` ❌ Failed to trigger detection: ${err.message}`);
        }
        
        // Wait a bit between detections
        await new Promise(r => setTimeout(r, 1000));
    }
}

function showHelp() {
    console.log(`
Usage: node src/tests/simulate.js --scenario=[multi-copy|rug|tp]

Available Scenarios:
  multi-copy  : Simulates multiple alpha wallets buying the same token.
  rug         : Simulates a sudden 60% liquidity drop on an open trade.
  tp          : Simulates price hitting TP1 (+50%) and then TP2 (+100%).
    `);
}

run().catch(err => {
    console.error('❌ Simulator Error:', err.message);
});
