const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const db = require('./database');
const telegram = require('./telegram');
require('dotenv').config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

class TradingService {
    constructor() {
        this.connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');
        this.wallet = null;
        if (process.env.SOLANA_PRIVATE_KEY) {
            this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
            console.log(`[Trading] Wallet loaded: ${this.wallet.publicKey.toString()}`);
        }
        this.isMonitoring = false;
    }

    async buyToken(tokenAddress, amountSol = process.env.DEFAULT_BUY_AMOUNT || 0.1) {
        if (!this.wallet) throw new Error('Wallet not configured');

        console.log(`[Trading] Buying ${amountSol} SOL of ${tokenAddress}...`);
        
        try {
            // 1. Get Quote
            const quoteResponse = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
                params: {
                    inputMint: SOL_MINT,
                    outputMint: tokenAddress,
                    amount: Math.floor(amountSol * 10**9),
                    slippageBps: 1000 // 10%
                }
            });

            // 2. Get Swap Transaction
            const swapResponse = await axios.post(`${JUPITER_QUOTE_API}/swap`, {
                quoteResponse: quoteResponse.data,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true
            });

            const { swapTransaction } = swapResponse.data;
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            
            // 3. Sign and Send
            transaction.sign([this.wallet]);
            const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                maxRetries: 2
            });

            await this.connection.confirmTransaction(txid);
            console.log(`[Trading] Buy success! TX: ${txid}`);

            // 4. Save to DB
            const buyPrice = await this.getPrice(tokenAddress);
            const tokenAmount = quoteResponse.data.outAmount; // in native decimals
            await db.openPosition(tokenAddress, buyPrice, tokenAmount, amountSol);

            return txid;
        } catch (error) {
            console.error('[Trading] Buy failed:', error.response?.data || error.message);
            throw error;
        }
    }

    async sellToken(position) {
        if (!this.wallet) throw new Error('Wallet not configured');

        console.log(`[Trading] Selling ${position.token_address} for profit...`);
        
        try {
            // 1. Get Quote (Token -> SOL)
            const quoteResponse = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
                params: {
                    inputMint: position.token_address,
                    outputMint: SOL_MINT,
                    amount: position.amount,
                    slippageBps: 1000
                }
            });

            // 2. Get Swap Transaction
            const swapResponse = await axios.post(`${JUPITER_QUOTE_API}/swap`, {
                quoteResponse: quoteResponse.data,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true
            });

            const { swapTransaction } = swapResponse.data;
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            
            transaction.sign([this.wallet]);
            const txid = await this.connection.sendRawTransaction(transaction.serialize());
            await this.connection.confirmTransaction(txid);
            
            console.log(`[Trading] Sell success! TX: ${txid}`);
            await db.closePosition(position.id);
            
            await telegram.sendMessage(`💰 *PROFIT TAKEN!*\nSold ${position.token_address}\nProfit: +100%\nTX: [View](https://solscan.io/tx/${txid})`);
            
            return txid;
        } catch (error) {
            console.error('[Trading] Sell failed:', error.message);
        }
    }

    async getPrice(tokenAddress) {
        try {
            const res = await axios.get(`https://api.jup.ag/price/v2?ids=${tokenAddress}`);
            return res.data.data[tokenAddress]?.price || 0;
        } catch (error) {
            console.error('[Trading] Price fetch failed:', error.message);
            return 0;
        }
    }

    async startAutoSell() {
        if (this.isMonitoring) return;
        this.isMonitoring = true;
        console.log('[Trading] Auto-sell engine started.');

        while (this.isMonitoring) {
            try {
                const openPositions = await db.getOpenPositions();
                for (const pos of openPositions) {
                    const currentPrice = await this.getPrice(pos.token_address);
                    if (currentPrice === 0) continue;

                    const profitPercent = ((currentPrice - pos.buy_price) / pos.buy_price) * 100;
                    console.log(`[Trading] ${pos.token_address} Profit: ${profitPercent.toFixed(2)}%`);

                    if (profitPercent >= 100) {
                        await this.sellToken(pos);
                    }
                }
            } catch (error) {
                console.error('[Trading] Monitor loop error:', error.message);
            }
            await new Promise(resolve => setTimeout(resolve, 30000)); // Check every 30s
        }
    }
}

module.exports = new TradingService();
