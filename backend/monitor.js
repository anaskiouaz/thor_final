const { Connection, PublicKey } = require('@solana/web3.js');
const db = require('./database');
const telegram = require('./telegram');
require('dotenv').config();

class SolanaMonitor {
    constructor() {
        this.connection = new Connection(process.env.RPC_URL || 'https://rpc.ankr.com/solana');
        this.isMonitoring = false;
        this.watchedWallets = new Set();
        this.processedTxs = new Set();
    }

    async refreshWallets() {
        const wallets = await db.getWallets();
        this.watchedWallets = new Set(wallets.map(w => w.address));
        console.log(`[Monitor] Watching ${this.watchedWallets.size} Solana wallets.`);
    }

    async start() {
        if (this.isMonitoring) return;
        this.isMonitoring = true;
        
        await this.refreshWallets();
        console.log(`[Monitor] Solana Monitoring started...`);

        this.monitorLoop();
    }

    async monitorLoop() {
        while (this.isMonitoring) {
            try {
                for (const walletAddress of this.watchedWallets) {
                    await this.checkWallet(walletAddress);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between wallets
                }
            } catch (error) {
                if (error.message.includes('429')) {
                    console.warn('[Monitor] Rate limit reached (429). Sleeping for 30s...');
                    await new Promise(resolve => setTimeout(resolve, 30000));
                } else {
                    console.error('[Monitor] Loop error:', error.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 20000)); // Poll every 20s (increased from 10s)
        }
    }

    async checkWallet(walletAddress) {
        let pubkey;
        try {
            pubkey = new PublicKey(walletAddress);
        } catch (e) {
            console.warn(`[Monitor] Skipping invalid address: ${walletAddress}`);
            return;
        }

        const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit: 3 });

        for (const sigInfo of signatures) {
            const signature = sigInfo.signature;
            if (this.processedTxs.has(signature)) continue;
            this.processedTxs.add(signature);

            const tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
            if (!tx) continue;

            // Check if this transaction created a new token (InitializeMint)
            const instructions = tx.transaction.message.instructions;
            for (const ix of instructions) {
                if (ix.program === 'spl-token' && ix.parsed?.type === 'initializeMint') {
                    const mintAddress = ix.parsed.info.mint;
                    console.log(`[Monitor] 🔥 New Token Mint detected: ${mintAddress}`);
                    
                    await db.logDetection(walletAddress, mintAddress, signature, tx.slot);
                    
                    await telegram.sendMessage(
                        `🔥 *Solana Token Mint Detected!*\n\n` +
                        `👤 *Deployer:* \`${walletAddress}\`\n` +
                        `📄 *Token Mint:* \`${mintAddress}\`\n` +
                        `🔗 [View on Solscan](https://solscan.io/token/${mintAddress})\n\n` +
                        `💡 Reply with \`/buy ${mintAddress}\` to purchase.`
                    );
                }
            }
        }

        // Keep processed set small
        if (this.processedTxs.size > 1000) this.processedTxs.clear();
    }

    stop() {
        this.isMonitoring = false;
        console.log('[Monitor] Solana Monitor stopped.');
    }
}

module.exports = new SolanaMonitor();
