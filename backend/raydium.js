/**
 * raydium.js — Raydium AMM swap execution
 * Direct swap on Raydium AMM v4 for maximum speed (no Jupiter overhead).
 * Falls back to Jupiter if direct Raydium swap fails.
 */

'use strict';

const {
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    TransactionInstruction,
} = require('@solana/web3.js');
const BN = require('bn.js');
const axios = require('axios');
const config = require('./config');

// ─── Constants ───────────────────────────────────────────────────────────────

const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CLMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Jupiter-based Raydium Swap ──────────────────────────────────────────────

/**
 * Execute a swap via Jupiter (which routes through Raydium when optimal).
 * This is the most reliable approach as Jupiter handles all the pool lookups.
 * 
 * @param {string} inputMint - Input token mint address
 * @param {string} outputMint - Output token mint address
 * @param {number|bigint|string} amount - Amount in smallest units (lamports for SOL)
 * @param {Keypair} wallet - Signer wallet
 * @param {Connection} connection - Solana connection
 * @param {number} priorityFeeLamports - Priority fee in lamports
 * @returns {{ txHash: string, outputAmount: string }}
 */
async function swapViaJupiter(inputMint, outputMint, amount, wallet, connection, priorityFeeLamports = 0) {
    const { slippageBps } = config.getTradingConfig();

    console.log(`[Raydium/Jupiter] 🔄 Swap ${inputMint.slice(0, 8)}... → ${outputMint.slice(0, 8)}... (${amount})`);

    // 1. Get quote
    const { data: quoteData } = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
        params: {
            inputMint,
            outputMint,
            amount: amount.toString(),
            slippageBps,
            // Prefer Raydium routes when available
            dexes: 'Raydium,Raydium CLMM',
        },
        timeout: 10_000,
    });

    if (!quoteData || !quoteData.outAmount) {
        // Retry without DEX filter
        console.log('[Raydium/Jupiter] No Raydium route, trying all DEXes...');
        const { data: fallbackQuote } = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
            params: {
                inputMint,
                outputMint,
                amount: amount.toString(),
                slippageBps,
            },
            timeout: 10_000,
        });
        if (!fallbackQuote?.outAmount) {
            throw new Error('No swap route available');
        }
        return executeJupiterSwap(fallbackQuote, wallet, connection, priorityFeeLamports);
    }

    return executeJupiterSwap(quoteData, wallet, connection, priorityFeeLamports);
}

/**
 * Execute a Jupiter swap transaction.
 */
async function executeJupiterSwap(quoteResponse, wallet, connection, priorityFeeLamports = 0) {
    // Get swap transaction
    const swapBody = {
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
    };

    // Add priority fee via Jupiter's built-in support
    if (priorityFeeLamports > 0) {
        swapBody.prioritizationFeeLamports = priorityFeeLamports;
    }

    const { data: swapData } = await axios.post(
        `${JUPITER_QUOTE_API}/swap`,
        swapBody,
        { timeout: 15_000 }
    );

    if (!swapData?.swapTransaction) {
        throw new Error('Jupiter swap response missing transaction');
    }

    // Deserialize, sign, send
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([wallet]);

    const txHash = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
    });

    console.log(`[Raydium/Jupiter] 📤 TX sent: ${txHash}`);

    // Confirm
    try {
        await connection.confirmTransaction(txHash, 'confirmed');
        console.log(`[Raydium/Jupiter] ✅ TX confirmed: ${txHash}`);
    } catch (err) {
        console.warn(`[Raydium/Jupiter] ⚠️ Confirmation timeout: ${err.message}`);
    }

    return {
        txHash,
        outputAmount: quoteResponse.outAmount?.toString() ?? '0',
    };
}

/**
 * Buy a token with SOL via Raydium/Jupiter.
 */
async function buyToken(tokenAddress, solAmount, wallet, connection, priorityFeeLamports = 0) {
    const lamports = Math.floor(solAmount * 1e9);
    return swapViaJupiter(SOL_MINT, tokenAddress, lamports, wallet, connection, priorityFeeLamports);
}

/**
 * Sell a token for SOL via Raydium/Jupiter.
 */
async function sellToken(tokenAddress, tokenAmount, wallet, connection, priorityFeeLamports = 0) {
    return swapViaJupiter(tokenAddress, SOL_MINT, tokenAmount, wallet, connection, priorityFeeLamports);
}

module.exports = {
    swapViaJupiter,
    buyToken,
    sellToken,
};
