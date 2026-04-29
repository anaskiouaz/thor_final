
/**
 * simulate_buy.js
 * Script to trigger a simulated buy for testing the auto-sell engine.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const trading = require('./trading');
const config = require('./config');
const db = require('./database');
const { Keypair } = require('@solana/web3.js');

async function simulate() {
    // Utilisation d'un token récemment détecté
    const tokenMint = '7mJ4tTSsL63fa69qkdDbw4fhx6SPzfA8uS4bVisStfi4'; 
    const walletSource = 'SIMULATED_TEST_WALLET';
    
    console.log(`\n[Simulation] 🚀 Initialisation d'un achat factice pour: ${tokenMint}`);
    
    const tradingConfig = config.getTradingConfig();
    
    if (!tradingConfig.dryRun) {
        console.error('[Simulation] 🛑 ERREUR: Le mode DRY_RUN n\'est pas activé dans le .env !');
        process.exit(1);
    }

    if (!trading.wallet) {
        console.log('[Simulation] 🛠️ Utilisation d\'un wallet temporaire pour la simulation...');
        trading.wallet = Keypair.generate();
    }

    try {
        console.log('[Simulation] Envoi de l\'ordre d\'achat simulé...');
        const result = await trading.autoBuy(
            tokenMint,
            walletSource,
            'pumpfun'
        );

        if (result) {
            console.log(`\n[Simulation] ✅ ACHAT RÉUSSI (Simulé) !`);
            console.log(`[Simulation] Trade ID: ${result.tradeId}`);
            console.log(`[Simulation] ℹ️  Le moteur d'auto-sell va surveiller le prix.`);
            console.log(`[Simulation] ℹ️  Dès que le profit (+${tradingConfig.tpPercent}%) ou la perte (${tradingConfig.slPercent}%) est atteint,`);
            console.log(`[Simulation]       le bot vendra automatiquement et t'enverra un message Telegram.`);
        } else {
            console.log(`\n[Simulation] ℹ️ L'achat a été ignoré (une position est peut-être déjà ouverte).`);
        }
        
        setTimeout(() => process.exit(0), 1000);

    } catch (err) {
        console.error(`\n[Simulation] ❌ Erreur critique:`, err.message);
        process.exit(1);
    }
}

simulate();
