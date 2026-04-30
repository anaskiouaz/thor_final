'use strict';

const {
    VersionedTransaction,
} = require('@solana/web3.js');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

async function swapViaJupiter(inputMint, outputMint, amount, wallet, connection, priorityFeeLamports = 0) {
    const { slippageBps } = config.getTradingConfig();
    logger.info({ component: 'Raydium/Jupiter' }, `🔄 Swap ${inputMint.slice(0, 8)}... → ${outputMint.slice(0, 8)}...`);

    try {
        let { data: quoteData } = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
            params: { inputMint, outputMint, amount: amount.toString(), slippageBps, dexes: 'Raydium,Raydium CLMM' },
            timeout: 10_000,
        });

        if (!quoteData?.outAmount) {
            const { data: fallbackQuote } = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
                params: { inputMint, outputMint, amount: amount.toString(), slippageBps },
                timeout: 10_000,
            });
            quoteData = fallbackQuote;
        }

        if (!quoteData?.outAmount) throw new Error('No swap route available');

        return executeJupiterSwap(quoteData, wallet, connection, priorityFeeLamports);
    } catch (err) {
        logger.error({ component: 'Raydium/Jupiter' }, `Swap failed: ${err.message}`);
        throw err;
    }
}

async function executeJupiterSwap(quoteResponse, wallet, connection, priorityFeeLamports = 0) {
    const swapBody = { quoteResponse, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true };
    if (priorityFeeLamports > 0) swapBody.prioritizationFeeLamports = priorityFeeLamports;

    const { data: swapData } = await axios.post(`${JUPITER_QUOTE_API}/swap`, swapBody, { timeout: 15_000 });
    if (!swapData?.swapTransaction) throw new Error('Jupiter swap response missing transaction');

    const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    transaction.sign([wallet]);
    const txHash = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 3 });

    try {
        await connection.confirmTransaction(txHash, 'confirmed');
    } catch (err) { logger.warn({ component: 'Raydium/Jupiter' }, `Confirmation timeout: ${err.message}`); }

    return { txHash, outputAmount: quoteResponse.outAmount?.toString() ?? '0' };
}

async function buyToken(tokenAddress, solAmount, wallet, connection, priorityFeeLamports = 0) {
    return swapViaJupiter(SOL_MINT, tokenAddress, Math.floor(solAmount * 1e9), wallet, connection, priorityFeeLamports);
}

async function sellToken(tokenAddress, tokenAmount, wallet, connection, priorityFeeLamports = 0) {
    return swapViaJupiter(tokenAddress, SOL_MINT, tokenAmount, wallet, connection, priorityFeeLamports);
}

module.exports = { swapViaJupiter, buyToken, sellToken };
