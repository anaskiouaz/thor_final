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
const config = require('../config');
const logger = require('../utils/logger');
const jito = require('./jito');

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_FEE_ACCOUNT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ15mxWx7ENp');
const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = SystemProgram.programId;
const RENT_PROGRAM = new PublicKey('SysvarRent111111111111111111111111111111111');
const PUMP_API_BASE = 'https://frontend-api-v3.pump.fun';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, options = {}, timeoutMs = 10_000) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function getAssociatedTokenAddress(mint, owner) {
    const [address] = PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM);
    return address;
}

function getBondingCurvePDA(mint, programId = PUMP_FUN_PROGRAM) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], programId);
    return pda;
}

async function isPumpFunToken(mintAddress) {
    try {
        const data = await fetchJSON(`${PUMP_API_BASE}/coins/${mintAddress}`, {}, 5_000);
        return { onCurve: data && !data.complete, data };
    } catch (err) { return { onCurve: false, data: null }; }
}

async function getBondingCurvePrice(mintAddress) {
    try {
        const data = await fetchJSON(`${PUMP_API_BASE}/coins/${mintAddress}`, {}, 5_000);
        return data ? { priceUsd: data.usd_market_cap / (data.total_supply / 1e6), marketCap: data.usd_market_cap } : null;
    } catch { return null; }
}

async function buyOnBondingCurve(mintAddress, solAmount, wallet, connection, priorityFeeLamports = 0, options = {}) {
    const mint = new PublicKey(mintAddress);
    const tradingConfig = config.getTradingConfig();
    const useJito = options.forceJito || tradingConfig.useJito;
    const { slippageBps } = config.getTradingConfig();
    const { data: tokenData } = await isPumpFunToken(mintAddress);
    const bondingCurve = getBondingCurvePDA(mint);
    const bondingCurveATA = getAssociatedTokenAddress(mint, bondingCurve);
    const userATA = getAssociatedTokenAddress(mint, wallet.publicKey);
    const lamportsIn = Math.floor(solAmount * 1e9);
    const maxSolCost = Math.floor(lamportsIn * (1 + slippageBps / 10000));
    const instructions = [];

    if (priorityFeeLamports > 0) {
        instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor((priorityFeeLamports * 1_000_000) / 250_000) }));
    }

    instructions.push(new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: userATA, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }], data: Buffer.from([1]) }));

    const buyDiscriminator = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
    const estimatedTokens = BigInt(Math.floor((lamportsIn / (tokenData.virtual_sol_reserves + lamportsIn)) * tokenData.virtual_token_reserves * 0.99));
    const amountBuf = new BN(estimatedTokens.toString()).toArrayLike(Buffer, 'le', 8);
    const maxSolCostBuf = new BN(maxSolCost.toString()).toArrayLike(Buffer, 'le', 8);
    const buyData = Buffer.concat([buyDiscriminator, amountBuf, maxSolCostBuf]);

    instructions.push(new TransactionInstruction({ programId: PUMP_FUN_PROGRAM, keys: [{ pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false }, { pubkey: PUMP_FUN_FEE_ACCOUNT, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: bondingCurve, isSigner: false, isWritable: true }, { pubkey: bondingCurveATA, isSigner: false, isWritable: true }, { pubkey: userATA, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }, { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false }, { pubkey: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'), isSigner: false, isWritable: false }, { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }], data: buyData }));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
    transaction.sign([wallet]);

    let txHash;
    if (useJito) {
        logger.info({ component: 'PumpFun' }, `🛡️ Executing via Jito Bundle... ${options.customTip ? `(Tip: ${options.customTip} SOL)` : ''}`);
        txHash = await jito.sendBundle([transaction], wallet, connection, options.customTip);
    } else {
        txHash = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 3 });
        await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');
    }
    return { txHash, tokensReceived: estimatedTokens.toString() };
}

async function sellOnBondingCurve(mintAddress, tokenAmount, wallet, connection, priorityFeeLamports = 0, options = {}) {
    const mint = new PublicKey(mintAddress);
    const tradingConfig = config.getTradingConfig();
    const useJito = options.forceJito || tradingConfig.useJito;
    const bondingCurve = getBondingCurvePDA(mint);
    const bondingCurveATA = getAssociatedTokenAddress(mint, bondingCurve);
    const userATA = getAssociatedTokenAddress(mint, wallet.publicKey);
    const instructions = [];

    if (priorityFeeLamports > 0) {
        instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor((priorityFeeLamports * 1_000_000) / 250_000) }));
    }

    const sellDiscriminator = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
    const amountBuf = new BN(tokenAmount.toString()).toArrayLike(Buffer, 'le', 8);
    const minSolBuf = new BN('0').toArrayLike(Buffer, 'le', 8);
    const sellData = Buffer.concat([sellDiscriminator, amountBuf, minSolBuf]);

    instructions.push(new TransactionInstruction({ programId: PUMP_FUN_PROGRAM, keys: [{ pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false }, { pubkey: PUMP_FUN_FEE_ACCOUNT, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: bondingCurve, isSigner: false, isWritable: true }, { pubkey: bondingCurveATA, isSigner: false, isWritable: true }, { pubkey: userATA, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }, { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false }, { pubkey: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'), isSigner: false, isWritable: false }, { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }], data: sellData }));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
    transaction.sign([wallet]);

    let txHash;
    if (useJito) {
        logger.info({ component: 'PumpFun' }, `🛡️ Executing via Jito Bundle... ${options.customTip ? `(Tip: ${options.customTip} SOL)` : ''}`);
        txHash = await jito.sendBundle([transaction], wallet, connection, options.customTip);
    } else {
        txHash = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 3 });
        await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');
    }
    return { txHash };
}

module.exports = { isPumpFunToken, getBondingCurvePrice, buyOnBondingCurve, sellOnBondingCurve, PUMP_FUN_PROGRAM };
