'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const db = require('../database');
const telegram = require('../telegram');
const config = require('../../config');
const logger = require('../../utils/logger');
const { heliusRpc, withRetry, sleep } = require('./rpc');
const { detectPurchase, detectCreation } = require('./parser');

const POLL_INTERVAL_MS = 120_000;
const WALLET_DELAY_MS = 1000;
const TX_FETCH_DELAY_MS = 200;
const MAX_SIGS_PER_POLL = 10;
const MAX_PROCESSED_SIZE = 5_000;

class SolanaMonitor {
    constructor() {
        this.isMonitoring = false;
        this.watchedWallets = new Set();
        this.processedTxs = new Map();
        this.subscriptions = new Map();
        this._trading = null;

        const { rpcUrl, wssUrl } = config.getHeliusConfig();
        if (rpcUrl && rpcUrl.startsWith('http')) {
            this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl, commitment: 'confirmed' });
        } else {
            logger.error({ component: 'Monitor' }, `❌ RPC_URL invalide ou manquant: ${rpcUrl}`);
        }

        global.solanaMonitor = this;
    }

    get trading() {
        if (!this._trading) {
            this._trading = require('../trading');
        }
        return this._trading;
    }

    async refreshWallets() {
        const wallets = await db.getWallets();
        const currentAddresses = new Set(wallets.map(w => w.address));

        for (const addr of currentAddresses) {
            if (!this.watchedWallets.has(addr)) {
                this.watchedWallets.add(addr);
                this._subscribe(addr);
            }
        }

        for (const addr of this.watchedWallets) {
            if (!currentAddresses.has(addr)) {
                this.watchedWallets.delete(addr);
                this._unsubscribe(addr);
            }
        }

        logger.info({ component: 'Monitor' }, `👀 Surveillance de ${this.watchedWallets.size} wallet(s) via WebSocket.`);
    }

    async start() {
        if (this.isMonitoring) return;
        if (!process.env.HELIUS_API_KEY) {
            logger.error({ component: 'Monitor' }, '❌ HELIUS_API_KEY manquant — monitor non démarré.');
            return;
        }
        this.isMonitoring = true;
        await this.refreshWallets();

        try {
            const recentSigs = await db.getRecentProcessedSignatures(2000);
            for (const sig of recentSigs) {
                this.processedTxs.set(sig, Date.now());
            }
            logger.info({ component: 'Monitor' }, `🧠 Mémoire chargée: ${this.processedTxs.size} signatures déjà traitées.`);
        } catch (err) {
            logger.warn({ component: 'Monitor' }, `Impossible de charger les signatures traitées: ${err.message}`);
        }

        logger.info({ component: 'Monitor' }, '✅ Solana monitor démarré (Helius RPC + Auto-Buy).');
        this._loop();
    }

    stop() {
        this.isMonitoring = false;
        for (const [addr, subId] of this.subscriptions) {
            this._unsubscribe(addr);
        }
        logger.info({ component: 'Monitor' }, '🛑 Solana monitor arrêté.');
    }

    reconnect() {
        logger.info({ component: 'Monitor' }, '🔄 Reconnexion des WebSockets avec la nouvelle clé...');
        const { rpcUrl, wssUrl } = config.getHeliusConfig();
        
        for (const addr of this.watchedWallets) {
            this._unsubscribe(addr);
        }
        
        if (rpcUrl && rpcUrl.startsWith('http')) {
            this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl, commitment: 'confirmed' });
            for (const addr of this.watchedWallets) {
                this._subscribe(addr);
            }
        } else {
            logger.error({ component: 'Monitor' }, `❌ Impossible de reconnecter : RPC_URL invalide (${rpcUrl})`);
        }
    }

    _subscribe(address) {
        if (this.subscriptions.has(address)) return;
        try {
            const pubkey = new PublicKey(address);
            const subId = this.connection.onLogs(
                pubkey,
                async (logs) => {
                    const sig = logs.signature;
                    if (this.processedTxs.has(sig)) return;

                    logger.info({ component: 'Monitor' }, `⚡ WebSocket alert for ${address.slice(0, 8)}... (TX: ${sig.slice(0, 8)}...)`);
                    await this._processSignature(address, sig);
                },
                'confirmed'
            );
            this.subscriptions.set(address, subId);
            logger.info({ component: 'Monitor' }, `🔌 WebSocket sub établi: ${address.slice(0, 12)}...`);
        } catch (err) {
            logger.error({ component: 'Monitor' }, `Erreur subscription ${address}: ${err.message}`);
        }
    }

    _unsubscribe(address) {
        const subId = this.subscriptions.get(address);
        if (subId !== undefined) {
            this.connection.removeOnLogsListener(subId).catch(() => { });
            this.subscriptions.delete(address);
            logger.info({ component: 'Monitor' }, `🔌 WebSocket unsub: ${address.slice(0, 12)}...`);
        }
    }

    async _loop() {
        while (this.isMonitoring) {
            try {
                const addresses = Array.from(this.watchedWallets);
                for (const addr of addresses) {
                    if (!this.isMonitoring) break;
                    await this._checkWallet(addr);
                    await sleep(WALLET_DELAY_MS);
                }
            } catch (err) {
                logger.error({ component: 'Monitor' }, `Loop error: ${err.message}`, { stack: err.stack });
            }
            this._evict();
            await sleep(POLL_INTERVAL_MS);
        }
    }

    async _checkWallet(walletAddress) {
        const sigInfos = await withRetry(() =>
            heliusRpc('getSignaturesForAddress', [
                walletAddress,
                { limit: MAX_SIGS_PER_POLL, commitment: 'confirmed' },
            ])
        ).catch(() => []);

        if (sigInfos && sigInfos.length > 0) {
            for (const sigInfo of sigInfos) {
                await this._processSignature(walletAddress, sigInfo.signature);
            }
        }
    }

    async _processSignature(walletAddress, sig) {
        if (this.processedTxs.has(sig)) return;

        this.processedTxs.set(sig, Date.now());
        await db.markSignatureProcessed(sig).catch(() => { });

        await sleep(TX_FETCH_DELAY_MS);

        try {
            const tx = await withRetry(() =>
                heliusRpc('getTransaction', [
                    sig,
                    { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' },
                ])
            ).catch(err => {
                logger.warn({ component: 'Monitor' }, `TX ignorée ${sig.slice(0, 12)}…: ${err.message}`);
                return null;
            });

            if (!tx) return;

            const slot = tx.slot ?? 0;
            const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '—';

            const createdMints = detectCreation(tx);
            for (const mint of createdMints) {
                const existing = await db.getDetectionsByWallet(walletAddress, 50);
                if (existing.some(d => d.token_address === mint && d.tx_hash === sig)) continue;

                const isNewToken = !(await db.hasTokenBeenDetected(mint));

                logger.info({ component: 'Monitor' }, `🔥 Création token: ${mint} par ${walletAddress}`);
                await db.logDetection(walletAddress, mint, sig, slot, 'creation');

                if (isNewToken) {
                    await telegram.sendMessage(
                        `🔥 *Nouveau Token Créé!*\n\n` +
                        `👤 *Déployeur:* \`${walletAddress}\`\n` +
                        `📄 *Mint:* \`${mint}\`\n` +
                        `🕐 ${blockTime}\n` +
                        `🔗 [Solscan](https://solscan.io/token/${mint})\n\n` +
                        `💡 \`/buy ${mint}\``
                    );
                    this._triggerAutoBuy(mint, walletAddress, 'pumpfun');
                }
            }

            const purchase = detectPurchase(tx, walletAddress);
            if (!purchase) return;

            for (const mint of purchase.mints) {
                if (createdMints.includes(mint)) continue;

                const existing = await db.getDetectionsByWallet(walletAddress, 50);
                if (existing.some(d => d.token_address === mint && d.tx_hash === sig)) continue;

                const isNewToken = !(await db.hasTokenBeenDetected(mint));

                logger.info({ component: 'Monitor' }, `💸 Achat: ${mint} par ${walletAddress} via ${purchase.dexType}${purchase.involvesDex ? ' (DEX)' : ''}`);
                await db.logDetection(walletAddress, mint, sig, slot, 'purchase');
                
                if (isNewToken) {
                    await telegram.sendMessage(
                        `💸 *Nouvel Achat Détecté!*\n\n` +
                        `👤 *Wallet:* \`${walletAddress}\`\n` +
                        `🪙 *Token:* \`${mint}\`\n` +
                        `🏷️ *DEX:* ${purchase.dexType}\n` +
                        `${purchase.involvesDex ? '🔄 Via DEX\n' : ''}` +
                        `🕐 ${blockTime}\n` +
                        `🔗 [TX Solscan](https://solscan.io/tx/${sig})\n\n` +
                        `🤖 Auto-buy en cours...`
                    );
                    this._triggerAutoBuy(mint, walletAddress, purchase.dexType);
                }
            }
        } catch (err) {
            logger.error({ component: 'Monitor' }, `Erreur lors du traitement de la TX ${sig}: ${err.message}`, { stack: err.stack });
        }
    }

    _triggerAutoBuy(tokenMint, walletSource, dexType) {
        setImmediate(async () => {
            try {
                const result = await this.trading.autoBuy(tokenMint, walletSource, dexType);
                if (result) {
                    logger.info({ component: 'Monitor' }, `🟢 Auto-buy triggered: trade #${result.tradeId}`);
                }
            } catch (err) {
                logger.error({ component: 'Monitor' }, `Auto-buy error for ${tokenMint}: ${err.message}`, { stack: err.stack });
            }
        });
    }

    _evict() {
        if (this.processedTxs.size <= MAX_PROCESSED_SIZE) return;
        const cutoff = Date.now() - POLL_INTERVAL_MS * 3;
        for (const [sig, ts] of this.processedTxs) {
            if (ts < cutoff) this.processedTxs.delete(sig);
            if (this.processedTxs.size <= MAX_PROCESSED_SIZE / 2) break;
        }
    }
}

module.exports = new SolanaMonitor();
