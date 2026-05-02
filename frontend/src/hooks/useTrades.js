import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from './useWebSocket';

export function useTrades() {
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchTradesAndStats = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        api.getRecentTrades(10),
        api.getTradeStats(),
      ]);
      setTrades(t);
      setStats(s);
    } catch (err) {
      console.error('Fetch trades/stats error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTradesAndStats();
    const interval = setInterval(fetchTradesAndStats, 15_000);
    return () => clearInterval(interval);
  }, [fetchTradesAndStats]);

  const handleWsMessage = useCallback((msg) => {
    if (!msg?.type) return;

    switch (msg.type) {
      case 'trade:new':
        setTrades(prev => [msg.data, ...prev].slice(0, 10));
        setStats(prev => prev ? { ...prev, totalTrades: prev.totalTrades + 1, openTrades: prev.openTrades + 1 } : prev);
        break;

      case 'trade:price':
        setTrades(prev => prev.map(t =>
          t.id === msg.data.id
            ? { ...t, current_price: msg.data.currentPrice, pnl_pct: msg.data.pnlPct, ath_usd: msg.data.athUsd || t.ath_usd }
            : t
        ));
        break;

      case 'trade:ath':
        setTrades(prev => prev.map(t =>
          t.id === msg.data.id ? { ...t, ath_usd: msg.data.athUsd } : t
        ));
        break;

      case 'trade:closed':
        setTrades(prev => prev.map(t =>
          t.id === msg.data.id
            ? { ...t, status: 'CLOSED', sell_reason: msg.data.reason, sell_price_usd: msg.data.sellPrice, pnl_pct: msg.data.pnlPct }
            : t
        ));
        setStats(prev => prev ? { ...prev, openTrades: Math.max(0, prev.openTrades - 1), closedTrades: prev.closedTrades + 1 } : prev);
        break;

      case 'trade:entryPrice':
        setTrades(prev => prev.map(t =>
          t.id === msg.data.id ? { ...t, entry_price_usd: msg.data.entryPrice } : t
        ));
        break;
    }
  }, []);

  const { isConnected } = useWebSocket(handleWsMessage);

  return {
    trades,
    stats,
    loading,
    isConnected,
    refresh: fetchTradesAndStats
  };
}
