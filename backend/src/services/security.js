'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config');
const helius = require('./helius');

class SecurityService {
    constructor() {
        this.rugCheckApi = 'https://api.rugcheck.xyz/v1/tokens';
    }

    /**
     * Analyse la sécurité d'un token avant achat.
     * @param {string} mintAddress 
     * @returns {Promise<{isSafe: boolean, score: number, reasons: string[]}>}
     */
    async checkToken(mintAddress) {
        const tradingConfig = config.getTradingConfig();
        const reasons = [];
        let score = 0;

        // 🛡️ Skip checks for mock tokens in simulation
        if (!mintAddress || mintAddress.length < 32 || mintAddress.includes('XAZ') || mintAddress.includes('Token')) {
            logger.info({ component: 'Security' }, `🧪 Skipping real security checks for mock token: ${mintAddress}`);
            return { isSafe: true, score: 0, reasons: [] };
        }

        try {
            logger.info({ component: 'Security' }, `🔍 Analyzing token: ${mintAddress}`);

            // 1. Appeler RugCheck API
            const report = await this._getRugCheckReport(mintAddress);
            if (report) {
                score = report.score || 0;
                
                if (score > tradingConfig.maxRiskScore) {
                    reasons.push(`High RugCheck score: ${score}`);
                }

                // Vérifier les risques spécifiques dans le rapport RugCheck
                if (report.risks) {
                    for (const risk of report.risks) {
                        if (tradingConfig.blockMintAuthority && (risk.name === 'Mint Authority Still Enabled' || risk.name === 'Mint Authority')) {
                            reasons.push('Mint Authority detected');
                        }
                        if (tradingConfig.blockFreezeAuthority && (risk.name === 'Freeze Authority Still Enabled' || risk.name === 'Freeze Authority')) {
                            reasons.push('Freeze Authority detected');
                        }
                        if (tradingConfig.blockMutableMetadata && (risk.name === 'Metadata is mutable' || risk.name === 'Mutable Metadata')) {
                            reasons.push('Mutable metadata detected');
                        }
                    }
                }

                // Check LP Burned (if available in report)
                const markets = report.markets || [];
                const totalLiquidity = markets.reduce((sum, m) => sum + (m.liquidity || 0), 0);
                
                if (markets.length > 0) {
                    const mainMarket = markets[0];
                    if (mainMarket.lp) {
                        const lpBurnedPct = mainMarket.lp.lpBurnedPct || 0;
                        if (lpBurnedPct < tradingConfig.minLpBurnedPct) {
                            reasons.push(`Low LP burned: ${lpBurnedPct}% (Min: ${tradingConfig.minLpBurnedPct}%)`);
                        }
                    }
                }

                // Check Liquidity
                if (totalLiquidity < tradingConfig.minLiquidityUsd) {
                    reasons.push(`Low liquidity: $${totalLiquidity.toFixed(2)} (Min: $${tradingConfig.minLiquidityUsd})`);
                }

                // Check Top Holders from report
                if (report.topHolders) {
                    for (const holder of report.topHolders.slice(0, 5)) {
                        // Ignore known non-risky owners if labeled (e.g. Raydium, Burn)
                        if (holder.pct > tradingConfig.maxTopHolderPct && !holder.owner) {
                            reasons.push(`Report: Large holder detected (${holder.pct.toFixed(2)}%)`);
                        }
                    }
                }
            }

            // 2. Analyse directe via Helius (au cas où RugCheck est en retard)
            const mintInfo = await this._getMintInfo(mintAddress);
            if (mintInfo) {
                if (tradingConfig.blockMintAuthority && mintInfo.mintAuthority) {
                    if (!reasons.includes('Mint Authority detected')) reasons.push('Mint Authority detected (on-chain)');
                }
                if (tradingConfig.blockFreezeAuthority && mintInfo.freezeAuthority) {
                    if (!reasons.includes('Freeze Authority detected')) reasons.push('Freeze Authority detected (on-chain)');
                }
            }

            // 3. Vérification des Top Holders (si non présent dans RugCheck ou pour doubler)
            const topHoldersRisk = await this._checkTopHolders(mintAddress);
            if (topHoldersRisk) {
                reasons.push(topHoldersRisk);
            }

            const isSafe = reasons.length === 0;
            if (!isSafe) {
                logger.warn({ component: 'Security' }, `🚫 Token ${mintAddress} rejected: ${reasons.join(', ')}`);
            } else {
                logger.info({ component: 'Security' }, `✅ Token ${mintAddress} passed security checks (Score: ${score})`);
            }

            return { isSafe, score, reasons };

        } catch (err) {
            logger.error({ component: 'Security' }, `Error checking token security: ${err.message}`);
            // En cas d'erreur de l'API, on est prudent ou on laisse passer ?
            // On va dire que si l'analyse échoue, on laisse passer mais on log l'erreur.
            // Ou on peut bloquer par défaut. Ici on va laisser passer pour ne pas bloquer le trading si RugCheck est down.
            return { isSafe: true, score: 0, reasons: [] };
        }
    }

    async _getRugCheckReport(mintAddress) {
        try {
            const { data } = await axios.get(`${this.rugCheckApi}/${mintAddress}/report`, { timeout: 5000 });
            return data;
        } catch (err) {
            logger.warn({ component: 'Security' }, `RugCheck API failed: ${err.message}`);
            return null;
        }
    }

    async _getMintInfo(mintAddress) {
        try {
            const data = await helius.rpc('getAccountInfo', [mintAddress, { encoding: 'jsonParsed' }]);
            const parsed = data?.value?.data?.parsed?.info;
            if (parsed) {
                return {
                    mintAuthority: parsed.mintAuthority,
                    freezeAuthority: parsed.freezeAuthority,
                    supply: parsed.supply
                };
            }
            return null;
        } catch (err) {
            return null;
        }
    }

    async _checkTopHolders(mintAddress) {
        try {
            const tradingConfig = config.getTradingConfig();
            // On utilise Helius pour récupérer les plus gros holders
            // Note: Helius getLargestAccounts est limité
            const data = await helius.rpc('getTokenLargestAccounts', [mintAddress]);
            const accounts = data?.value || [];
            
            if (accounts.length === 0) return null;

            // Récupérer la supply totale
            const supplyData = await helius.rpc('getTokenSupply', [mintAddress]);
            const supplyAmount = supplyData?.value?.amount || supplyData?.amount;
            if (!supplyAmount) return null;

            const totalSupply = BigInt(supplyAmount);
            if (totalSupply === 0n) return null;
            
            for (const holder of accounts.slice(0, 5)) {
                const balance = BigInt(holder.amount);
                const percent = Number((balance * 10000n) / totalSupply) / 100; // Basis points for precision
                
                if (percent > tradingConfig.maxTopHolderPct) {
                    // On pourrait exclure les adresses connues de Raydium/Jupiter/Burn
                    // Mais RugCheck le fait déjà mieux.
                    return `On-chain: Large holder detected (${percent.toFixed(2)}%)`;
                }
            }
            return null;
        } catch (err) {
            return null;
        }
    }
}

module.exports = new SecurityService();
