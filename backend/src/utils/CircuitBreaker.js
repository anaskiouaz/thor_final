'use strict';

const logger = require('./logger');

class CircuitBreaker {
    constructor(name, options = {}) {
        this.name = name;
        this.failureThreshold = options.failureThreshold || 5;
        this.cooldownPeriod = options.cooldownPeriod || 30000; // 30s
        
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.nextAttempt = 0;
    }

    async fire(fn, ...args) {
        if (this.state === 'OPEN') {
            if (Date.now() >= this.nextAttempt) {
                this.state = 'HALF_OPEN';
                logger.info({ component: 'CircuitBreaker' }, `[${this.name}] Testing connection (HALF_OPEN)...`);
            } else {
                throw new Error(`CircuitBreaker [${this.name}] is OPEN. Cooldown remaining: ${Math.round((this.nextAttempt - Date.now()) / 1000)}s`);
            }
        }

        try {
            const result = await fn(...args);
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure(error);
            throw error;
        }
    }

    onSuccess() {
        this.failures = 0;
        this.state = 'CLOSED';
    }

    onFailure(error) {
        // Only count rate limits as failures for Helius breaker
        if (error.message.includes('429')) {
            this.failures++;
            logger.warn({ component: 'CircuitBreaker' }, `[${this.name}] Failure detected (${this.failures}/${this.failureThreshold}): ${error.message}`);
            
            if (this.failures >= this.failureThreshold) {
                this.state = 'OPEN';
                this.nextAttempt = Date.now() + this.cooldownPeriod;
                logger.error({ component: 'CircuitBreaker' }, `[${this.name}] Circuit is now OPEN. Cooldown for ${this.cooldownPeriod / 1000}s`);
            }
        }
    }
}

module.exports = CircuitBreaker;
