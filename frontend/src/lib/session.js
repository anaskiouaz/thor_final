/**
 * session.js — Manage backend session (Real vs Simulation)
 */

const STORAGE_KEY = 'thor_backend_port';
const DEFAULT_PORT = 3000;

export const getSessionPort = () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_PORT;
};

export const setSessionPort = (port) => {
    localStorage.setItem(STORAGE_KEY, port.toString());
    window.location.reload(); // Simplest way to ensure everything (API, WS) refreshes
};

export const isSimulation = () => getSessionPort() === 3001;
