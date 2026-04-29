/**
 * monitor.js — Solana wallet monitor (Helius RPC) + Auto-Buy trigger
 * Détecte les achats de memecoins par les wallets surveillés.
 * Déclenche automatiquement l'achat via trading.js quand un wallet surveillé trade.
 */

'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const db = require('./database');
const telegram = require('./telegram');
const config = require('./config');
require('dotenv').config();

// ─── Constants ───────────────────────────────────────────────────────────────

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const POLL_INTERVAL_MS = 120_000; // 2 min (safety net polling)
const WALLET_DELAY_MS = 1000;
const TX_FETCH_DELAY_MS = 200;
const MAX_SIGS_PER_POLL = 10;
const MAX_PROCESSED_SIZE = 5_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns a formatted timestamp string for logs: [HH:MM:SS.mmm] */
function ts() {
    const now = new Date();
    return `[${now.toLocaleTimeString('fr-FR', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
}

async function heliusRpc(method, params) {
    const { rpcUrl } = config.getHeliusConfig();
    console.log(`${ts()} [Monitor API] Helius RPC: ${method}`);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    
    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Helius ${method} HTTP ${res.status}: ${text.slice(0, 120)}`);
        }
        const json = await res.json();
        if (json.error) throw new Error(`Helius ${method} RPC error: ${JSON.stringify(json.error)}`);
        return json.result;
    } catch (err) {
        if (err.message.includes('429') || err.message.includes('403')) {
            if (config.switchToBackup()) {
                // Notifier le monitor qu'on a changé de config (pour WS)
                if (global.solanaMonitor) global.solanaMonitor.reconnect();
                return heliusRpc(method, params);
            }
        }
        throw err;
    }
}

async function withRetry(fn, retries = 3, baseDelayMs = 1_500) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
        try { return await fn(); }
        catch (err) {
            lastErr = err;
            if (attempt < retries - 1) {
                const delay = baseDelayMs * 2 ** attempt;
                console.warn(`${ts()} [Monitor] Retry ${attempt + 1}/${retries} in ${delay}ms — ${err.message}`);
                await sleep(delay);
            }
        }
    }
    throw lastErr;
}

/**
 * Identify which DEX was used in a transaction based on program IDs.
 * Returns 'pumpfun' | 'raydium' | 'jupiter' | 'unknown'
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
    // Check for Jupiter
    if (programIds.some(p => p.startsWith('JUP'))) return 'jupiter';

    return 'unknown';
}

// ─── Détection ───────────────────────────────────────────────────────────────

/**
 * Analyse une transaction parsée et retourne les mints achetés par walletAddress.
 * Un "achat" = le wallet reçoit un token SPL non-SOL dont le solde augmente.
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

    // Identifier les programs utilisés
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
 * Détecte la création d'un token (initializeMint) dans une transaction.
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

// ─── Monitor class ────────────────────────────────────────────────────────────

class SolanaMonitor {
    constructor() {
        this.isMonitoring = false;
        this.watchedWallets = new Set();
        this.processedTxs = new Map();   // sig → timestamp
        this.subscriptions = new Map();  // address → subscription ID

        // trading module is loaded lazily to avoid circular deps
        this._trading = null;

        const { rpcUrl, wssUrl } = config.getHeliusConfig();
        this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl, commitment: 'confirmed' });

        global.solanaMonitor = this; // Permettre au heliusRpc helper de trigger une reconnexion
    }

    /**
     * Get the trading service (lazy-loaded to avoid circular dependency).
     */
    get trading() {
        if (!this._trading) {
            this._trading = require('./trading');
        }
        return this._trading;
    }

    // ── API publique ────────────────────────────────────────────────────────

    async refreshWallets() {
        const wallets = await db.getWallets();
        const currentAddresses = new Set(wallets.map(w => w.address));

        // 1. Ajouter les nouveaux
        for (const addr of currentAddresses) {
            if (!this.watchedWallets.has(addr)) {
                this.watchedWallets.add(addr);
                this._subscribe(addr);
            }
        }

        // 2. Supprimer les anciens
        for (const addr of this.watchedWallets) {
            if (!currentAddresses.has(addr)) {
                this.watchedWallets.delete(addr);
                this._unsubscribe(addr);
            }
        }

        console.log(`${ts()} [Monitor] 👀 Surveillance de ${this.watchedWallets.size} wallet(s) via WebSocket.`);
    }

    async start() {
        if (this.isMonitoring) return;
        if (!process.env.HELIUS_API_KEY) {
            console.error('[Monitor] ❌ HELIUS_API_KEY manquant — monitor non démarré.');
            return;
        }
        this.isMonitoring = true;
        await this.refreshWallets();

        // Charger les signatures traitées récemment depuis la DB pour éviter les doublons au restart
        try {
            const recentSigs = await db.getRecentProcessedSignatures(2000);
            for (const sig of recentSigs) {
                this.processedTxs.set(sig, Date.now());
            }
            console.log(`${ts()} [Monitor] 🧠 Mémoire chargée: ${this.processedTxs.size} signatures déjà traitées.`);
        } catch (err) {
            console.warn(`${ts()} [Monitor] Impossible de charger les signatures traitées:`, err.message);
        }

        console.log(`${ts()} [Monitor] ✅ Solana monitor démarré (Helius RPC + Auto-Buy).`);
        this._loop();
    }

    stop() {
        this.isMonitoring = false;
        for (const [addr, subId] of this.subscriptions) {
            this._unsubscribe(addr);
        }
        console.log(`${ts()} [Monitor] 🛑 Solana monitor arrêté.`);
    }

    /** Reconnexion suite à un basculement de quota */
    reconnect() {
        console.log(`${ts()} [Monitor] 🔄 Reconnexion des WebSockets avec la nouvelle clé...`);
        const { rpcUrl, wssUrl } = config.getHeliusConfig();
        
        // Fermer les anciennes subs
        for (const addr of this.watchedWallets) {
            this._unsubscribe(addr);
        }
        
        // Nouvelle connexion
        this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl, commitment: 'confirmed' });
        
        // Rétablir les subs
        for (const addr of this.watchedWallets) {
            this._subscribe(addr);
        }
    }

    // ── Privé ────────────────────────────────────────────────────────────────

    /** S'abonner aux logs d'un wallet via WebSocket */
    _subscribe(address) {
        if (this.subscriptions.has(address)) return;
        try {
            const pubkey = new PublicKey(address);
            const subId = this.connection.onLogs(
                pubkey,
                async (logs) => {
                    const sig = logs.signature;
                    if (this.processedTxs.has(sig)) return;

                    console.log(`${ts()} [Monitor] ⚡ WebSocket alert for ${address.slice(0, 8)}... (TX: ${sig.slice(0, 8)}...)`);
                    await this._processSignature(address, sig);
                },
                'confirmed'
            );
            this.subscriptions.set(address, subId);
            console.log(`${ts()} [Monitor] 🔌 WebSocket sub établi: ${address.slice(0, 12)}...`);
        } catch (err) {
            console.error(`${ts()} [Monitor] Erreur subscription ${address}:`, err.message);
        }
    }

    /** Se désabonner d'un wallet */
    _unsubscribe(address) {
        const subId = this.subscriptions.get(address);
        if (subId !== undefined) {
            this.connection.removeOnLogsListener(subId).catch(() => { });
            this.subscriptions.delete(address);
            console.log(`${ts()} [Monitor] 🔌 WebSocket unsub: ${address.slice(0, 12)}...`);
        }
    }

    /** Boucle de sécurité (polling lent) au cas où WS raterait une TX */
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
                console.error(`${ts()} [Monitor] Loop error:`, err.message);
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

        // Marquer immédiatement en mémoire et DB
        this.processedTxs.set(sig, Date.now());
        await db.markSignatureProcessed(sig).catch(() => { });

        await sleep(TX_FETCH_DELAY_MS);

        try {
            // 2. Récupérer la transaction parsée
            const tx = await withRetry(() =>
                heliusRpc('getTransaction', [
                    sig,
                    { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' },
                ])
            ).catch(err => {
                console.warn(`${ts()} [Monitor] TX ignorée ${sig.slice(0, 12)}…: ${err.message}`);
                return null;
            });

            if (!tx) return;

            const slot = tx.slot ?? 0;
            const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '—';

            // 3. Détection création de token
            const createdMints = detectCreation(tx);
            for (const mint of createdMints) {
                // Dedup: vérifier si déjà loggé en DB
                const existing = await db.getDetectionsByWallet(walletAddress, 50);
                if (existing.some(d => d.token_address === mint && d.tx_hash === sig)) continue;

                // Check if this token was ever detected before
                const isNewToken = !(await db.hasTokenBeenDetected(mint));

                console.log(`${ts()} [Monitor] 🔥 Création token: ${mint} par ${walletAddress}`);
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

                    // ── AUTO-BUY on token creation ──────────────────────────
                    this._triggerAutoBuy(mint, walletAddress, 'pumpfun');
                } else {
                    console.log(`${ts()} [Monitor] ⏭️ Ignoré (Déjà vu): ${mint}`);
                }
            }

            // 4. Détection achat
            const purchase = detectPurchase(tx, walletAddress);
            if (!purchase) return;

            for (const mint of purchase.mints) {
                if (createdMints.includes(mint)) continue; // déjà traité

                // Dedup: vérifier si déjà loggé en DB
                const existing = await db.getDetectionsByWallet(walletAddress, 50);
                if (existing.some(d => d.token_address === mint && d.tx_hash === sig)) continue;

                // Check if this token was ever detected before
                const isNewToken = !(await db.hasTokenBeenDetected(mint));

                console.log(`${ts()} [Monitor] 💸 Achat: ${mint} par ${walletAddress} via ${purchase.dexType}${purchase.involvesDex ? ' (DEX)' : ''}`);
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

                    // ── AUTO-BUY on purchase detection ──────────────────────
                    this._triggerAutoBuy(mint, walletAddress, purchase.dexType);
                } else {
                    console.log(`${ts()} [Monitor] ⏭️ Achat ignoré: Le token ${mint} a déjà été détecté auparavant.`);
                }
            }
        } catch (err) {
            console.error(`${ts()} [Monitor] Erreur lors du traitement de la TX ${sig}:`, err.message);
        }
    }

    /**
     * Trigger an automatic buy (non-blocking).
     * Runs async in the background so the monitor doesn't wait.
     */
    _triggerAutoBuy(tokenMint, walletSource, dexType) {
        // Fire and forget
        setImmediate(async () => {
            try {
                const result = await this.trading.autoBuy(tokenMint, walletSource, dexType);
                if (result) {
                    console.log(`${ts()} [Monitor] 🟢 Auto-buy triggered: trade #${result.tradeId}`);
                }
            } catch (err) {
                console.error(`${ts()} [Monitor] Auto-buy error for ${tokenMint}:`, err.message);
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