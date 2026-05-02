/**
 * api.js — Centralized API client for Thor v2
 */

import axios from 'axios';
import { getSessionPort } from './session';

const API_BASE = `http://${window.location.hostname}:${getSessionPort()}/api`;

const api = axios.create({
    baseURL: API_BASE,
    timeout: 15_000,
});

// ─── Wallets ─────────────────────────────────────────────────────────────────

export const getWallets = () => api.get('/wallets').then(r => r.data);
export const addWallet = (address, label) => api.post('/wallets', { address, label }).then(r => r.data);
export const deleteWallet = (id) => api.delete(`/wallets/${id}`).then(r => r.data);
export const updateWalletLabel = (id, label) => api.patch(`/wallets/${id}`, { label }).then(r => r.data);
export const getWalletDetail = (address) => api.get(`/wallets/${address}/detail`).then(r => r.data);
export const getWalletAudit = (address, force = false) => api.get(`/wallets/${address}/audit${force ? '?force=true' : ''}`).then(r => r.data);

// ─── Detections ──────────────────────────────────────────────────────────────

export const getDetections = () => api.get('/detections').then(r => r.data);

// ─── Trades ──────────────────────────────────────────────────────────────────

export const getRecentTrades = (limit = 10) => api.get(`/trades/recent?limit=${limit}`).then(r => r.data);
export const getOpenTrades = () => api.get('/trades/open').then(r => r.data);
export const getTradeStats = () => api.get('/trades/stats').then(r => r.data);
export const getTradeById = (id) => api.get(`/trades/${id}`).then(r => r.data);

// ─── Config ──────────────────────────────────────────────────────────────────

export const getConfig = () => api.get('/config').then(r => r.data);
export const updateDryRun = (dryRun) => api.post('/config/dryrun', { dryRun }).then(r => r.data);
export const updateConfig = (newConfig) => api.post('/config/update', newConfig).then(r => r.data);

export default api;
