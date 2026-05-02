import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';

export function useWallets() {
  const [wallets, setWallets] = useState([]);
  const [botConfig, setBotConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchWalletsAndConfig = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([
        api.getWallets(),
        api.getConfig(),
      ]);
      setWallets(w);
      setBotConfig(c);
    } catch (err) {
      console.error('Fetch wallets/config error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWalletsAndConfig();
    const interval = setInterval(fetchWalletsAndConfig, 30_000);
    return () => clearInterval(interval);
  }, [fetchWalletsAndConfig]);

  const toggleDryRun = useCallback(async (isDryRun) => {
    try {
      const res = await api.updateDryRun(isDryRun);
      if (res.success) {
        setBotConfig(prev => prev ? { ...prev, dryRun: isDryRun } : prev);
      }
    } catch (err) {
      console.error('Error updating dry run:', err);
    }
  }, []);

  return {
    wallets,
    botConfig,
    setBotConfig,
    loading,
    refresh: fetchWalletsAndConfig,
    toggleDryRun
  };
}
