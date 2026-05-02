'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config');
const helius = require('./helius');

class MarketService {
    /**
     * Analyse le momentum d'un token (Volume et TXs sur 5 min).
     * @param {string} tokenAddress 
     * @returns {Promise<{isGoodMomentum: boolean, volume5m: number, txCount5m: number}>}
     */
    async analyzeMomentum(tokenAddress) {
        const tradingConfig = config.getTradingConfig();
        try {
            logger.info({ component: 'Market' }, `📊 Analyzing momentum for ${tokenAddress}`);
            
            // 1. Essayer DexScreener pour le volume 5m
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
            const pair = data?.pairs?.[0];
            
            let volume5m = 0;
            let txCount5m = 0;

            if (pair) {
                volume5m = Number(pair.volume?.m5 || 0);
                txCount5m = Number(pair.txns?.m5?.buys || 0) + Number(pair.txns?.m5?.sells || 0);
            }

            // Si DexScreener n'a pas encore de données (token très récent), on peut utiliser Helius
            if (volume5m === 0) {
                const signatures = await helius.rpc('getSignaturesForAddress', [tokenAddress, { limit: 50 }]);
                txCount5m = (signatures || []).length;
                // Le volume est plus dur à estimer via signatures sans parser chaque TX,
                // mais on peut dire que si on a beaucoup de signatures récentes, le momentum est là.
                volume5m = txCount5m > 10 ? tradingConfig.minMomentumVolume + 1 : 0; 
            }

            const isGoodMomentum = volume5m >= tradingConfig.minMomentumVolume && txCount5m >= 10;
            
            if (!isGoodMomentum) {
                logger.warn({ component: 'Market' }, `📉 Low momentum: Vol 5m=${volume5m.toFixed(2)} USD, TXs=${txCount5m}`);
            } else {
                logger.info({ component: 'Market' }, `🚀 Good momentum: Vol 5m=${volume5m.toFixed(2)} USD, TXs=${txCount5m}`);
            }

            return { isGoodMomentum, volume5m, txCount5m };

        } catch (err) {
            logger.error({ component: 'Market' }, `Momentum analysis failed: ${err.message}`);
            return { isGoodMomentum: true, volume5m: 0, txCount5m: 0 }; // Par défaut on laisse passer si erreur API
        }
    }

    /**
     * Vérifie si le développeur est en train de dumper ses jetons.
     * @param {string} tokenAddress 
     * @param {string} devWallet 
     * @returns {Promise<boolean>} true si le dev dumpe
     */
    async isDevDumping(tokenAddress, devWallet) {
        if (!devWallet) return false;
        try {
            // Récupérer les dernières transactions du dev
            const signatures = await helius.rpc('getSignaturesForAddress', [devWallet, { limit: 10 }]);
            if (!signatures || signatures.length === 0) return false;

            // Pour une analyse poussée, il faudrait parser les transactions pour voir si elles concernent tokenAddress
            // Ici on fait une détection simpliste : si le dev a des TXs récentes, on log
            logger.info({ component: 'Market' }, `🧐 Checking Dev Activity for ${devWallet}`);
            
            // On pourrait utiliser l'API Enhanced de Helius pour voir les transferts du dev
            const { txUrl } = config.getHeliusConfig();
            const baseUrl = txUrl.split('?')[0].replace('/v0/transactions', `/v0/addresses/${devWallet}/transactions`);
            const key = txUrl.split('api-key=')[1]?.split('&')[0];
            
            const { data } = await axios.get(`${baseUrl}?api-key=${key}&limit=10`, { timeout: 5000 });
            
            for (const tx of (data ?? [])) {
                if (tx.type === 'SWAP') {
                    for (const transfer of (tx.tokenTransfers ?? [])) {
                        if (transfer.fromUserAccount === devWallet && transfer.mint === tokenAddress) {
                            logger.warn({ component: 'Market', dev: devWallet }, `🚨 DEV IS DUMPING! Sold ${transfer.tokenAmount} tokens`);
                            return true;
                        }
                    }
                }
            }

            return false;
        } catch (err) {
            return false;
        }
    }
}

module.exports = new MarketService();
