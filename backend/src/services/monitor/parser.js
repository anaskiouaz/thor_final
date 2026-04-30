'use strict';

const config = require('../../config');

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Identify which DEX was used in a transaction based on program IDs.
 */
function identifyDex(programIds) {
    const pumpfunIds = new Set(config.PUMPFUN_PROGRAM_IDS);
    const raydiumIds = new Set(config.RAYDIUM_PROGRAM_IDS);

    for (const pid of programIds) {
        if (pumpfunIds.has(pid)) return 'pumpfun';
    }
    for (const pid of programIds) {
        if (raydiumIds.has(pid)) return 'raydium';
    }
    if (programIds.some(p => p.startsWith('JUP'))) return 'jupiter';

    return 'unknown';
}

/**
 * Detect purchase of tokens in a parsed transaction.
 */
function detectPurchase(tx, walletAddress) {
    if (!tx?.meta) return null;

    const { preTokenBalances = [], postTokenBalances = [] } = tx.meta;

    const preByMint = {};
    for (const b of preTokenBalances) {
        if (b.owner === walletAddress && b.mint !== WRAPPED_SOL) {
            preByMint[b.mint] = BigInt(b.uiTokenAmount?.amount || '0');
        }
    }

    const acquired = [];
    for (const b of postTokenBalances) {
        if (b.owner !== walletAddress || b.mint === WRAPPED_SOL) continue;
        const pre = preByMint[b.mint] ?? 0n;
        const post = BigInt(b.uiTokenAmount?.amount || '0');
        if (post > pre) acquired.push(b.mint);
    }
    if (acquired.length === 0) return null;

    const programIds = [
        ...(tx.transaction?.message?.instructions ?? []).map(ix =>
            ix.programId?.toString() ?? ix.program
        ),
        ...(tx.meta?.innerInstructions ?? []).flatMap(i =>
            i.instructions.map(ix => ix.programId?.toString() ?? ix.program)
        ),
    ].filter(Boolean);

    const involvesDex = programIds.some(p => config.ALL_DEX_PROGRAMS.has(p));
    const dexType = identifyDex(programIds);

    return { mints: acquired, involvesDex, dexType, programIds };
}

/**
 * Detect creation of a token (initializeMint).
 */
function detectCreation(tx) {
    const all = [
        ...(tx?.transaction?.message?.instructions ?? []),
        ...(tx?.meta?.innerInstructions ?? []).flatMap(i => i.instructions),
    ];
    return all
        .filter(ix =>
            (ix.program === 'spl-token' ||
                ix.programId === TOKEN_PROGRAM ||
                ix.programId === TOKEN_2022) &&
            ix.parsed?.type === 'initializeMint'
        )
        .map(ix => ix.parsed?.info?.mint)
        .filter(Boolean);
}

module.exports = {
    identifyDex,
    detectPurchase,
    detectCreation
};
