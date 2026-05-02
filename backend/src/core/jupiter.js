'use strict';

const { VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const jito = require('./jito');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

async function getQuote(inputMint, outputMint, amount) {
    const { slippageBps } = config.getTradingConfig();
    try {
        const { data } = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
            params: {
                inputMint,
                outputMint,
                amount: amount.toString(),
                slippageBps,
                onlyDirectRoutes: false,
            },
            timeout: 10_000,
        });
        return data;
    } catch (err) {
        logger.error({ component: 'Jupiter' }, `Quote error: ${err.message}`);
        throw err;
    }
}

async function swap(inputMint, outputMint, amount, wallet, connection, priorityFeeLamports = 0, options = {}) {
    const tradingConfig = config.getTradingConfig();
    const useJito = options.forceJito || tradingConfig.useJito;

    logger.info({ component: 'Jupiter' }, `🔄 Swapping ${amount} ${inputMint === SOL_MINT ? 'SOL' : 'Tokens'}... ${useJito ? '(via Jito)' : ''}`);

    try {
        const quoteResponse = await getQuote(inputMint, outputMint, amount);
        if (!quoteResponse) throw new Error('Could not get Jupiter quote');

        const swapBody = {
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
        };

        // If Jito is enabled, we don't use Jupiter's prioritization fee, we use Jito tip instead
        if (!useJito && priorityFeeLamports > 0) {
            swapBody.prioritizationFeeLamports = priorityFeeLamports;
        }

        const { data: swapData } = await axios.post(`${JUPITER_QUOTE_API}/swap`, swapBody, { timeout: 15_000 });
        if (!swapData?.swapTransaction) throw new Error('Jupiter swap response missing transaction');

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
        transaction.sign([wallet]);

        let txHash;
        if (useJito) {
            logger.info({ component: 'Jupiter' }, '🛡️ Executing via Jito Bundle...');
            txHash = await jito.sendBundle([transaction], wallet, connection, options.customTip);
        } else {
            txHash = await connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                maxRetries: 3,
            });
            
            // Confirm transaction
            try {
                await connection.confirmTransaction(txHash, 'confirmed');
            } catch (err) {
                logger.warn({ component: 'Jupiter' }, `Confirmation timeout for ${txHash}: ${err.message}`);
            }
        }

        return {
            txHash,
            outputAmount: quoteResponse.outAmount?.toString() ?? '0',
            price: Number(quoteResponse.outAmount) / Number(quoteResponse.inAmount)
        };
    } catch (err) {
        logger.error({ component: 'Jupiter' }, `Swap execution failed: ${err.message}`);
        throw err;
    }
}

async function buyToken(tokenAddress, solAmount, wallet, connection, priorityFeeLamports = 0) {
    return swap(SOL_MINT, tokenAddress, Math.floor(solAmount * 1e9), wallet, connection, priorityFeeLamports);
}

async function sellToken(tokenAddress, tokenAmount, wallet, connection, priorityFeeLamports = 0, options = {}) {
    return swap(tokenAddress, SOL_MINT, tokenAmount, wallet, connection, priorityFeeLamports, options);
}

module.exports = { getQuote, swap, buyToken, sellToken };
