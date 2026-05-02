'use strict';

const {
    VersionedTransaction,
    SystemProgram,
    PublicKey,
    TransactionInstruction,
    TransactionMessage
} = require('@solana/web3.js');
const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config');
const heliometer = require('../services/heliometer');

// Jito Block Engine endpoints
const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZu5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FxyR798He9veL7WMC6MkWmdJsAtRndTo3oZ2',
    'ADaUMid9yfUytqMBmgrZ9iSgqs9cf8xz9pA7SiSLCQR7',
    'DfXygSm4jCyvDsU1MdtRrfSHeAnnULemxmsWHfBpjace',
    'ADuB17ZSTarRs92TrSQQsBkQX987v3i566V5Fr98YpRP',
    'DttWaMuVvTiduRMhb2ToS7S3R9Mnd83VAbB9yKkCBy8p',
    '3AVi9Tg9Uo68ayJ9B68v76Vp76Z24LAb8o63r9nshn8a',
];

async function sendBundle(transactions, wallet, connection, customTipSol = null) {
    const tradingConfig = config.getTradingConfig();
    const tipAmount = Math.floor((customTipSol ?? tradingConfig.jitoTipSol) * 1e9);
    
    if (tipAmount <= 0) {
        throw new Error('Jito tip amount must be greater than 0');
    }

    try {
        const randomTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
        const tipAccountPubkey = new PublicKey(randomTipAccount);

        // Add tip instruction to the last transaction or create a new one
        // For simplicity, we'll create a small transfer transaction for the tip
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        
        const tipInstruction = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: tipAccountPubkey,
            lamports: tipAmount,
        });

        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [tipInstruction],
        }).compileToV0Message();

        const tipTransaction = new VersionedTransaction(messageV0);
        tipTransaction.sign([wallet]);

        const bundle = [
            ...transactions.map(tx => Buffer.from(tx.serialize()).toString('base64')),
            Buffer.from(tipTransaction.serialize()).toString('base64')
        ];

        const bestJitoUrl = heliometer.getJitoUrl();
        const otherEndpoints = JITO_ENDPOINTS.filter(url => url !== bestJitoUrl);

        // Send to best endpoint first, then all others
        const requests = [bestJitoUrl, ...otherEndpoints].map(endpoint => 
            axios.post(endpoint, {
                jsonrpc: '2.0',
                id: 1,
                method: 'sendBundle',
                params: [bundle],
            }, { timeout: 4000 }).catch(err => ({ error: err.message }))
        );

        const results = await Promise.all(requests);
        const success = results.find(r => r.data && r.data.result);
        
        if (success) {
            logger.info({ component: 'Jito' }, `✅ Bundle sent successfully: ${success.data.result}`);
            return success.data.result;
        } else {
            const errors = results.map(r => r.data?.error?.message || r.error).filter(Boolean);
            throw new Error(`Failed to send bundle: ${errors.join(', ')}`);
        }
    } catch (err) {
        logger.error({ component: 'Jito' }, `❌ Jito error: ${err.message}`);
        throw err;
    }
}

module.exports = { sendBundle };
