'use strict';

const db = require('../services/database');
const trading = require('../services/trading');
const monitor = require('../services/monitor');
const telegram = require('../services/telegram');
const logger = require('./logger');

// Valid looking Base58 addresses for testing
const MOCK_WALLETS = [
    { address: '6a4ZpU2Zp8r9XpGzZ6a4ZpU2Zp8r9XpGzZ6a4ZpU2Zp8', label: 'Alpha 1' },
    { address: '7b5YqV3Yq9sAXqHzA7b5YqV3Yq9sAXqHzA7b5YqV3Yq9s', label: 'Alpha 2' },
    { address: '8c6ZrW4ZrAtBYrIzB8c6ZrW4ZrAtBYrIzB8c6ZrW4ZrAt', label: 'Alpha 3' }
];

async function runMultiCopyScenario() {
    console.log('\n--- Scenario 1: Multiple Alpha Copy ---');
    const tokenMint = 'DezXAZ8z7PnrnMc7L469Z9U8T14ZpGzZ6a4ZpU2Zp8'; // Fake but valid format
    
    // Ensure wallets exist in DB
    for (const w of MOCK_WALLETS) {
        try { await db.addWallet(w.address, w.label); } catch (e) {}
    }

    console.log(`Step 1: Wallet A detects ${tokenMint}`);
    await monitor._triggerAutoBuy(tokenMint, MOCK_WALLETS[0].address, 'pumpfun');

    await new Promise(r => setTimeout(r, 2000));

    console.log(`Step 2: Wallet B detects ${tokenMint}`);
    await monitor._triggerAutoBuy(tokenMint, MOCK_WALLETS[1].address, 'pumpfun');

    await new Promise(r => setTimeout(r, 2000));

    console.log(`Step 3: Wallet C detects ${tokenMint}`);
    await monitor._triggerAutoBuy(tokenMint, MOCK_WALLETS[2].address, 'pumpfun');
}

async function runRugPanicScenario() {
    console.log('\n--- Scenario 2: Anti-Rug (Panic Sell) ---');
    const tokenMint = 'RugXAZ8z7PnrnMc7L469Z9U8T14ZpGzZ6a4ZpU2Zp8';
    
    const trade = await db.createTrade({
        tokenAddress: tokenMint,
        tokenSymbol: 'RUG',
        tokenName: 'Rug Token',
        walletSource: MOCK_WALLETS[0].address,
        buyPriceUsd: 1.0,
        amountTokens: '1000000',
        solSpent: 0.1,
        entryLiquidity: 10000,
        status: 'OPEN'
    });
    await db.activateTrade(trade.id, 'MOCK_TX_RUG', 1.0, '1000000');

    console.log(`Trade opened for ${tokenMint}. Entry Liquidity: 10000`);

    const originalGetTokenQuote = trading.getTokenQuote;
    trading.getTokenQuote = async (address) => {
        if (address === tokenMint) {
            return { price: 0.5, marketCap: 5000, liquidity: 3000, source: 'mock' }; // 70% drop
        }
        return originalGetTokenQuote.call(trading, address);
    };

    console.log('Liquidity simulated drop to 3000 (-70%). Waiting for AutoSell check...');
    
    const autosell = require('../services/autosell');
    const tradingConfig = require('../config').getTradingConfig();
    
    const updatedTrade = await db.getTradeById(trade.id);
    await autosell._evaluateTrade(updatedTrade, tradingConfig);

    trading.getTokenQuote = originalGetTokenQuote;
}

async function runBreakEvenScenario() {
    console.log('\n--- Scenario 3: Break-Even ---');
    const tokenMint = 'BeXAZ8z7PnrnMc7L469Z9U8T14ZpGzZ6a4ZpU2Zp8';
    
    const trade = await db.createTrade({
        tokenAddress: tokenMint,
        tokenSymbol: 'BE',
        tokenName: 'BreakEven Token',
        walletSource: MOCK_WALLETS[0].address,
        buyPriceUsd: 1.0,
        amountTokens: '1000000',
        solSpent: 0.1,
        status: 'OPEN'
    });
    await db.activateTrade(trade.id, 'MOCK_TX_BE', 1.0, '1000000');
    await db.updateTradeEntryPrice(trade.id, 1.0);

    const originalGetPrice = trading.getPrice;
    const autosell = require('../services/autosell');
    const tradingConfig = require('../config').getTradingConfig();

    console.log('Step 1: Price goes to $1.25 (+25%)');
    trading.getPrice = async () => 1.25;
    let updatedTrade = await db.getTradeById(trade.id);
    await autosell._evaluateTrade(updatedTrade, tradingConfig);

    await new Promise(r => setTimeout(r, 1000));

    console.log('Step 2: Price back to $1.0 (Entry) -> TRIGGER BREAK EVEN');
    trading.getPrice = async () => 1.0;
    updatedTrade = await db.getTradeById(trade.id);
    await autosell._evaluateTrade(updatedTrade, tradingConfig);

    trading.getPrice = originalGetPrice;
}

async function main() {
    try {
        await runMultiCopyScenario();
        await runRugPanicScenario();
        await runBreakEvenScenario();
        console.log('\n✅ All scenarios executed.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Test failed:', err);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
