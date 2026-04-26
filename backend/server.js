const express = require('express');
const axios = require('axios');
const cors = require('cors');
const db = require('./database');
const monitor = require('./monitor');
const telegram = require('./telegram');
const { Connection, PublicKey } = require('@solana/web3.js');
const ethers = require('ethers');
require('dotenv').config();

const getChain = (address) => {
    if (address.startsWith('0x')) return 'evm';
    try {
        new PublicKey(address);
        return 'solana';
    } catch (e) {
        return 'unknown';
    }
};

const app = express();
const PORT = process.env.PORT || 3000;
const walletCache = new Map(); // address -> { data, timestamp }
const CACHE_TTL = 60000; // 60 seconds

app.use(cors());
app.use(express.json());

// API Endpoints

// Get all watched wallets
app.get('/api/wallets', async (req, res) => {
    try {
        const wallets = await db.getWallets();
        res.json(wallets);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add a wallet to watch
app.post('/api/wallets', async (req, res) => {
    const { address, label } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    // Validate Solana Address
    try {
        new PublicKey(address);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid Solana address format' });
    }

    try {
        const newWallet = await db.addWallet(address, label);
        await monitor.refreshWallets(); // Update monitor's list

        // Notify via Telegram
        await telegram.sendMessage(`✅ *New Wallet Added*\nLabel: ${label || 'None'}\nAddress: \`${address}\``);

        res.status(201).json(newWallet);
    } catch (err) {
        console.error('[Server] Error adding wallet:', err);
        if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'This wallet is already being monitored.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Delete a watched wallet
app.delete('/api/wallets/:id', async (req, res) => {
    try {
        await db.deleteWallet(req.params.id);
        await monitor.refreshWallets(); // Update monitor's list
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get detection history
app.get('/api/detections', async (req, res) => {
    try {
        const detections = await db.getDetections();
        res.json(detections);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get wallet detail from Solscan/Solana
app.get('/api/wallets/:address/detail', async (req, res) => {
    const { address } = req.params;
    try {
        // Detect chain
        const chain = getChain(address);
        if (chain === 'unknown') {
            return res.status(400).json({ error: 'Invalid address format' });
        }

        // Cache TTL: 5 minutes for public nodes
        const CACHE_TTL = 5 * 60 * 1000;
        
        // Check cache first
        const cached = walletCache.get(address);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }

        let pubkey;
        try {
            pubkey = new PublicKey(address);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid Solana public key' });
        }

        // Use Ankr as a better default public RPC
        const connection = new Connection(process.env.RPC_URL || 'https://rpc.ankr.com/solana');

        let responseData = {
            address,
            chain,
            balance: 0,
            createdTokens: [],
            explorerBase: chain === 'solana' ? 'https://solscan.io' : 'https://basescan.org'
        };

        if (chain === 'solana') {
            try {
                console.log(`[Server] Fetching data for ${address} via free RPC & DexScreener...`);
                const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
                const pubkey = new PublicKey(address);
                
                // Set a timeout for the entire blockchain fetch
                const fetchPromise = (async () => {
                    console.log('[Server] Step 1: Getting SOL Balance...');
                    const balance = await connection.getBalance(pubkey);
                    responseData.balance = balance / 10**9;

                    console.log('[Server] Step 2: Getting Token Accounts...');
                    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
                        programId: TOKEN_PROGRAM_ID
                    });

                    const activeTokens = tokenAccounts.value
                        .filter(a => a.account.data.parsed.info.tokenAmount.uiAmount > 0)
                        .slice(0, 5);

                    console.log(`[Server] Step 3: Fetching Metadata for ${activeTokens.length} tokens...`);
                    const enrichedTokens = [];
                    for (const ta of activeTokens) {
                        const mint = ta.account.data.parsed.info.mint;
                        const amount = ta.account.data.parsed.info.tokenAmount.uiAmount;
                        try {
                            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 2000 });
                            const pair = dexRes.data?.pairs?.[0];
                            enrichedTokens.push({
                                mint,
                                symbol: pair?.baseToken?.symbol || 'UNKNOWN',
                                name: pair?.baseToken?.name || 'Token',
                                amount,
                                timestamp: Date.now()
                            });
                        } catch (dexErr) {
                            enrichedTokens.push({ mint, symbol: '???', name: 'Unknown', amount, timestamp: Date.now() });
                        }
                    }
                    return enrichedTokens;
                })();

                // Race against a 10s timeout
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('RPC Timeout')), 10000)
                );

                responseData.createdTokens = await Promise.race([fetchPromise, timeoutPromise]);
                console.log('[Server] Fetch complete!');
                
                walletCache.set(address, { data: responseData, timestamp: Date.now() });
                return res.json(responseData);

            } catch (err) {
                console.warn('[Server] Solana fetch partial failure:', err.message);
                // Return what we have (even if it's just 0s)
                return res.json(responseData);
            }
        } else {
            // EVM (Base by default)
            try {
                const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
                const balance = await provider.getBalance(address);
                responseData.balance = parseFloat(ethers.formatEther(balance));
                responseData.createdTokens = []; // Simplified for now
            } catch (evmErr) {
                console.error('[Server] EVM fetch error:', evmErr.message);
                // Continue with 0 balance
            }
        }

        walletCache.set(address, { data: responseData, timestamp: Date.now() });
        res.json(responseData);
    } catch (err) {
        console.error('[Server] Detail fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start the server and monitor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Running on http://0.0.0.0:${PORT}`);
    console.log(`[Server] Access via Tailscale IP if connected.`);

    // Start blockchain monitor
    if (process.env.RPC_URL) {
        monitor.start();
    } else {
        console.warn('[Server] WARNING: RPC_URL not found in .env. Monitor will not start.');
    }

    // Start auto-sell engine
    const trading = require('./trading');
    trading.startAutoSell();
});
