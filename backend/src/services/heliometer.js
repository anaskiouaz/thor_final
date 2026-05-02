'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config');

const PING_INTERVAL_MS = 30_000;

const JITO_ENDPOINTS = [
    { name: 'NY', url: 'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles' },
    { name: 'Amsterdam', url: 'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles' },
    { name: 'Frankfurt', url: 'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles' },
    { name: 'Tokyo', url: 'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles' },
];

class Heliometer {
    constructor() {
        this.bestRpc = null;
        this.bestJito = JITO_ENDPOINTS[0];
        this.rpcLatencies = new Map();
        this.jitoLatencies = new Map();
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info({ component: 'Heliometer' }, '🚀 Starting RPC & Jito benchmarking...');
        this._loop();
    }

    async _loop() {
        while (this.isRunning) {
            try {
                await Promise.all([
                    this._benchmarkRpcs(),
                    this._benchmarkJito()
                ]);
            } catch (err) {
                logger.error({ component: 'Heliometer' }, `Benchmark error: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, PING_INTERVAL_MS));
        }
    }

    async _benchmarkRpcs() {
        const { rpcUrl, rpcUrl1 } = config.getHeliusConfig();
        const urls = [
            { name: 'Helius Primary', url: rpcUrl },
            { name: 'Helius Backup', url: rpcUrl1 },
            { name: 'QuickNode', url: process.env.QUICKNODE_RPC_URL },
            { name: 'Alchemy', url: process.env.ALCHEMY_RPC_URL },
        ].filter(r => r.url);

        const results = await Promise.all(urls.map(async (rpc) => {
            const start = Date.now();
            try {
                await axios.post(rpc.url, {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getLatestBlockhash',
                    params: [{ commitment: 'confirmed' }]
                }, { timeout: 5000 });
                const latency = Date.now() - start;
                return { ...rpc, latency, success: true };
            } catch (err) {
                return { ...rpc, latency: 9999, success: false };
            }
        }));

        const sorted = results.filter(r => r.success).sort((a, b) => a.latency - b.latency);
        if (sorted.length > 0) {
            this.bestRpc = sorted[0];
            logger.debug({ component: 'Heliometer' }, `Best RPC: ${this.bestRpc.name} (${this.bestRpc.latency}ms)`);
        }
    }

    async _benchmarkJito() {
        const results = await Promise.all(JITO_ENDPOINTS.map(async (endpoint) => {
            const start = Date.now();
            try {
                // Jito doesn't have a simple health check via POST, so we just measure the connect time or a fake request
                await axios.get(endpoint.url.replace('/api/v1/bundles', '/api/v1/health'), { timeout: 3000 }).catch(() => {});
                const latency = Date.now() - start;
                return { ...endpoint, latency, success: true };
            } catch (err) {
                return { ...endpoint, latency: 9999, success: false };
            }
        }));

        const sorted = results.sort((a, b) => a.latency - b.latency);
        if (sorted.length > 0) {
            this.bestJito = sorted[0];
            logger.debug({ component: 'Heliometer' }, `Best Jito: ${this.bestJito.name} (${this.bestJito.latency}ms)`);
        }
    }

    getRpcUrl() {
        return this.bestRpc?.url || config.getHeliusConfig().rpcUrl;
    }

    getJitoUrl() {
        return this.bestJito?.url || JITO_ENDPOINTS[0].url;
    }

    /**
     * Force an immediate switch to a backup RPC
     */
    async forceFailover() {
        logger.warn({ component: 'Heliometer' }, '⚠️ Force failover triggered! Benchmarking RPCs immediately...');
        await this._benchmarkRpcs();
        return this.getRpcUrl();
    }
}

module.exports = new Heliometer();
