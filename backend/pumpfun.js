/**
 * pumpfun.js — Pump.fun bonding curve interaction
 * Handles direct buys on the Pump.fun bonding curve (before Raydium listing).
 */

'use strict';

const {
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    SystemProgram,
    ComputeBudgetProgram,
    TransactionInstruction,
} = require('@solana/web3.js');
const BN = require('bn.js');
const config = require('./config');
const logger = require('./lib/logger');

// ─── Constants ───────────────────────────────────────────────────────────────

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_CLASSIC = new PublicKey('PumpkinsEq8xENVZE62QqojeZT6J9x5sHze1P5m4P6c');
const PUMP_FUN_FEE_ACCOUNT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ15mxWx7ENp');
const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FUN_MINT_AUTHORITY = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = SystemProgram.programId;
const RENT_PROGRAM = new PublicKey('SysvarRent111111111111111111111111111111111');
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const PUMP_API_BASE = 'https://frontend-api-v3.pump.fun';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, options = {}, timeoutMs = 10_000) {
    const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

/**
 * Derive the Associated Token Account address.
 */
function getAssociatedTokenAddress(mint, owner) {
    const [address] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM
    );
    return address;
}

/**
 * Derive the Pump.fun bonding curve PDA for a given mint.
 */
function getBondingCurvePDA(mint, programId = PUMP_FUN_PROGRAM) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        programId
    );
    return pda;
}

/**
 * Derive the associated bonding curve token account.
 */
function getBondingCurveATA(bondingCurve, mint) {
    return getAssociatedTokenAddress(mint, bondingCurve);
}

// ─── Pump.fun API ────────────────────────────────────────────────────────────

/**
 * Check if a token is on the Pump.fun bonding curve (not yet migrated to Raydium).
 */
async function isPumpFunToken(mintAddress) {
    try {
        const data = await fetchJSON(`${PUMP_API_BASE}/coins/${mintAddress}`, {}, 5_000);
        // If the API returns data and the token isn't marked as "complete" (migrated), it's on the curve
        if (data && !data.complete) {
            return { onCurve: true, data };
        }
        return { onCurve: false, data };
    } catch (err) {
        // API error — token may not exist on Pump.fun
        logger.warn({ component: 'PumpFun' }, `API check failed for ${mintAddress}: ${err.message}`);
        return { onCurve: false, data: null };
    }
}

/**
 * Get the current price on the bonding curve for a given token.
 */
async function getBondingCurvePrice(mintAddress) {
    try {
        const data = await fetchJSON(`${PUMP_API_BASE}/coins/${mintAddress}`, {}, 5_000);
        if (data) {
            return {
                priceUsd: data.usd_market_cap && data.total_supply
                    ? (data.usd_market_cap / (data.total_supply / 1e6))
                    : 0,
                virtualSolReserves: data.virtual_sol_reserves,
                virtualTokenReserves: data.virtual_token_reserves,
                marketCap: data.usd_market_cap,
            };
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Buy on Bonding Curve ────────────────────────────────────────────────────

/**
 * Build and send a buy transaction on the Pump.fun bonding curve.
 * 
 * @param {string} mintAddress - Token mint address
 * @param {number} solAmount - Amount of SOL to spend
 * @param {Keypair} wallet - Signer wallet
 * @param {Connection} connection - Solana connection
 * @param {number} priorityFeeLamports - Priority fee in lamports
 * @returns {{ txHash: string, tokensReceived: string }}
 */
async function buyOnBondingCurve(mintAddress, solAmount, wallet, connection, priorityFeeLamports = 0) {
    const mint = new PublicKey(mintAddress);
    const { slippageBps } = config.getTradingConfig();
    
    logger.info({ component: 'PumpFun', token: mintAddress }, `🎯 Buying ${solAmount} SOL on bonding curve...`);

    // 1. Get token info from Pump.fun API
    const { onCurve, data: tokenData } = await isPumpFunToken(mintAddress);
    if (!onCurve) {
        throw new Error(`Token ${mintAddress} is not on the Pump.fun bonding curve`);
    }

    // 2. Determine which program to use
    let programId = PUMP_FUN_PROGRAM;
    // Try classic program if the main one doesn't work
    const bondingCurve = getBondingCurvePDA(mint, programId);
    const bondingCurveATA = getBondingCurveATA(bondingCurve, mint);
    const userATA = getAssociatedTokenAddress(mint, wallet.publicKey);

    // 3. Calculate expected tokens based on bonding curve
    const lamportsIn = Math.floor(solAmount * 1e9);
    // Apply slippage to max SOL cost — with 80% slippage, we accept paying up to 1.8x
    const maxSolCost = Math.floor(lamportsIn * (1 + slippageBps / 10000));

    // 4. Build instructions
    const instructions = [];

    // Priority fee
    if (priorityFeeLamports > 0) {
        // Estimate compute units — Pump.fun buys typically use ~200k CU
        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: Math.floor((priorityFeeLamports * 1_000_000) / 250_000),
            })
        );
    }

    // Create ATA if needed (idempotent instruction)
    instructions.push(
        new TransactionInstruction({
            programId: ASSOCIATED_TOKEN_PROGRAM,
            keys: [
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                { pubkey: userATA, isSigner: false, isWritable: true },
                { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([1]), // CreateIdempotent
        })
    );

    // Pump.fun buy instruction
    // Discriminator for "buy": [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]
    const buyDiscriminator = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
    const amountBuf = Buffer.alloc(8);
    // amount = tokens we want (we set to a large value and let maxSolCost control)
    // Use the bonding curve reserves to estimate
    const estimatedTokens = tokenData?.virtual_token_reserves && tokenData?.virtual_sol_reserves
        ? BigInt(Math.floor(
            (lamportsIn / (tokenData.virtual_sol_reserves + lamportsIn)) *
            tokenData.virtual_token_reserves * 0.99 // 1% buffer
        ))
        : BigInt(0);

    const amountBN = new BN(estimatedTokens.toString());
    amountBN.toArrayLike(Buffer, 'le', 8).copy(amountBuf);

    const maxSolCostBuf = Buffer.alloc(8);
    const maxSolBN = new BN(maxSolCost.toString());
    maxSolBN.toArrayLike(Buffer, 'le', 8).copy(maxSolCostBuf);

    const buyData = Buffer.concat([buyDiscriminator, amountBuf, maxSolCostBuf]);

    instructions.push(
        new TransactionInstruction({
            programId,
            keys: [
                { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
                { pubkey: PUMP_FUN_FEE_ACCOUNT, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                { pubkey: bondingCurveATA, isSigner: false, isWritable: true },
                { pubkey: userATA, isSigner: false, isWritable: true },
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'), isSigner: false, isWritable: false }, // event authority
                { pubkey: programId, isSigner: false, isWritable: false },
            ],
            data: buyData,
        })
    );

    // 5. Build versioned transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    // 6. Send & confirm
    const txHash = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
    });

    logger.info({ component: 'PumpFun', token: mintAddress, txHash }, `📤 TX sent: ${txHash}`);

    // Wait for confirmation with timeout
    try {
        await connection.confirmTransaction(
            { signature: txHash, blockhash, lastValidBlockHeight },
            'confirmed'
        );
        logger.info({ component: 'PumpFun', token: mintAddress, txHash }, `✅ TX confirmed: ${txHash}`);
    } catch (err) {
        logger.warn({ component: 'PumpFun', token: mintAddress, txHash }, `⚠️ Confirmation timeout: ${err.message}`);
    }

    // 7. Get actual tokens received from the transaction
    let tokensReceived = estimatedTokens.toString();
    try {
        await sleep(2000);
        const txInfo = await connection.getTransaction(txHash, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        });
        if (txInfo?.meta?.postTokenBalances) {
            for (const balance of txInfo.meta.postTokenBalances) {
                if (balance.owner === wallet.publicKey.toString() && balance.mint === mintAddress) {
                    const pre = txInfo.meta.preTokenBalances?.find(
                        b => b.owner === wallet.publicKey.toString() && b.mint === mintAddress
                    );
                    const preAmount = BigInt(pre?.uiTokenAmount?.amount ?? '0');
                    const postAmount = BigInt(balance.uiTokenAmount?.amount ?? '0');
                    if (postAmount > preAmount) {
                        tokensReceived = (postAmount - preAmount).toString();
                    }
                }
            }
        }
    } catch (err) {
        logger.warn({ component: 'PumpFun', token: mintAddress }, `Could not verify tokens received: ${err.message}`);
    }

    return { txHash, tokensReceived };
}

/**
 * Sell tokens back to the Pump.fun bonding curve.
 */
async function sellOnBondingCurve(mintAddress, tokenAmount, wallet, connection, priorityFeeLamports = 0) {
    const mint = new PublicKey(mintAddress);
    const { slippageBps } = config.getTradingConfig();

    logger.info({ component: 'PumpFun', token: mintAddress }, `📤 Selling ${tokenAmount} tokens on bonding curve...`);

    const programId = PUMP_FUN_PROGRAM;
    const bondingCurve = getBondingCurvePDA(mint, programId);
    const bondingCurveATA = getBondingCurveATA(bondingCurve, mint);
    const userATA = getAssociatedTokenAddress(mint, wallet.publicKey);

    const instructions = [];

    if (priorityFeeLamports > 0) {
        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: Math.floor((priorityFeeLamports * 1_000_000) / 250_000),
            })
        );
    }

    // Sell discriminator: [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]
    const sellDiscriminator = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
    const amountBuf = Buffer.alloc(8);
    const amountBN = new BN(tokenAmount.toString());
    amountBN.toArrayLike(Buffer, 'le', 8).copy(amountBuf);

    // Min SOL output with slippage (accept very low output to ensure sale goes through)
    const minSolBuf = Buffer.alloc(8);
    // 0 lamports min = we accept any output (80% slippage equivalent)
    new BN('0').toArrayLike(Buffer, 'le', 8).copy(minSolBuf);

    const sellData = Buffer.concat([sellDiscriminator, amountBuf, minSolBuf]);

    instructions.push(
        new TransactionInstruction({
            programId,
            keys: [
                { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
                { pubkey: PUMP_FUN_FEE_ACCOUNT, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                { pubkey: bondingCurveATA, isSigner: false, isWritable: true },
                { pubkey: userATA, isSigner: false, isWritable: true },
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'), isSigner: false, isWritable: false },
                { pubkey: programId, isSigner: false, isWritable: false },
            ],
            data: sellData,
        })
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    const txHash = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
    });

    logger.info({ component: 'PumpFun', token: mintAddress, txHash }, `📤 Sell TX sent: ${txHash}`);

    try {
        await connection.confirmTransaction(
            { signature: txHash, blockhash, lastValidBlockHeight },
            'confirmed'
        );
        logger.info({ component: 'PumpFun', token: mintAddress, txHash }, `✅ Sell TX confirmed: ${txHash}`);
    } catch (err) {
        logger.warn({ component: 'PumpFun', token: mintAddress, txHash }, `⚠️ Sell confirmation timeout: ${err.message}`);
    }

    return { txHash };
}

module.exports = {
    isPumpFunToken,
    getBondingCurvePrice,
    buyOnBondingCurve,
    sellOnBondingCurve,
    PUMP_FUN_PROGRAM,
    PUMP_FUN_CLASSIC,
};
