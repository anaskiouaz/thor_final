'use strict';

class MemoryCache {
    constructor(ttlMs = 60000) {
        this.cache = new Map();
        this.ttlMs = ttlMs;
    }

    set(key, value, customTtl = null) {
        const expiresAt = Date.now() + (customTtl || this.ttlMs);
        this.cache.set(key, { value, expiresAt });
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return null;
        }

        return entry.value;
    }

    has(key) {
        return this.get(key) !== null;
    }

    delete(key) {
        this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }
}

module.exports = MemoryCache;
