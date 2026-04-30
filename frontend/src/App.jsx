import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import * as api from './lib/api';
import {
  Plus, Trash2, Shield, Wallet, Activity, Copy, Check,
  ExternalLink, TrendingUp, TrendingDown, Zap, BarChart3,
  Target, AlertTriangle, ChevronDown, RefreshCw, Settings
} from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(p) {
  if (!p || p === 0) return '$0.00';
  if (p < 0.0001) return `$${p.toExponential(2)}`;
  if (p < 1) return `$${p.toFixed(6)}`;
  return `$${p.toFixed(2)}`;
}

function formatPnl(pct) {
  if (pct == null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function shortAddr(addr, len = 4) {
  if (!addr) return '—';
  return `${addr.slice(0, len)}...${addr.slice(-len)}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getDexBadgeClass(dex) {
  if (!dex) return 'badge-pending';
  if (dex.includes('pump')) return 'badge-pumpfun';
  if (dex.includes('ray')) return 'badge-raydium';
  if (dex.includes('jup')) return 'badge-jupiter';
  return 'badge-pending';
}

function getStatusBadge(trade) {
  if (trade.status === 'OPEN') return 'badge-open';
  if (trade.status === 'PENDING') return 'badge-pending';
  if (trade.sell_reason === 'TP') return 'badge-tp';
  if (trade.sell_reason === 'SL') return 'badge-sl';
  return 'badge-closed';
}

function getStatusLabel(trade) {
  if (trade.status === 'OPEN') return 'OPEN';
  if (trade.status === 'PENDING') return 'PENDING...';
  if (trade.status === 'BUY_FAILED') return 'BUY FAILED';
  if (trade.sell_reason === 'TP') return 'TP ✓';
  if (trade.sell_reason === 'SL') return 'SL ✗';
  return trade.sell_reason || 'CLOSED';
}

function formatMC(val) {
  if (!val || val === 0) return '—';
  if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `$${(val / 1000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

// ─── CopyableAddress ─────────────────────────────────────────────────────────

const CopyButton = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 hover:bg-white/5 rounded transition-colors text-slate-500 hover:text-white"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
};

// ─── StatCard ────────────────────────────────────────────────────────────────

const StatCard = ({ icon: Icon, label, value, sub, color = 'text-indigo-400' }) => (
  <div className="stat-card animate-fade-in-up">
    <div className="flex items-center gap-2 mb-2">
      <Icon className={`w-4 h-4 ${color}`} />
      <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</span>
    </div>
    <p className="text-2xl font-bold text-white">{value}</p>
    {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
  </div>
);

// ─── TradeRow ────────────────────────────────────────────────────────────────

const TradeRow = ({ trade, index }) => {
  const entryPrice = trade.entry_price_usd || trade.buy_price_usd || 0;
  const pnl = trade.pnl_pct || 0;
  const isProfit = pnl >= 0;
  const isOpen = trade.status === 'OPEN';

  // PnL bar width (clamped -100 to +200)
  const barWidth = Math.min(100, Math.max(0, (pnl + 100) / 3));

  return (
    <tr
      className="group border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Token */}
      <td className="py-3 px-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/20 flex items-center justify-center text-xs font-bold text-indigo-300">
            {(trade.token_symbol || '?')[0]}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white text-sm">{trade.token_symbol || '???'}</span>
              <span className={`badge ${getDexBadgeClass(trade.dex_used)}`}>{(trade.dex_used || 'unknown').replace('_dry', '')}</span>
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[11px] font-mono text-slate-500">{shortAddr(trade.token_address, 6)}</span>
              <CopyButton text={trade.token_address} />
              <a href={`https://solscan.io/token/${trade.token_address}`} target="_blank" rel="noreferrer"
                className="text-slate-600 hover:text-indigo-400 transition-colors">
                <ExternalLink className="w-3 h-3" />
              </a>
              {trade.last_error && (
                <div className="group/err relative">
                  <AlertTriangle className="w-3 h-3 text-red-400 cursor-help" />
                  <div className="absolute bottom-full left-0 mb-2 w-48 p-2 bg-red-900/90 text-white text-[10px] rounded border border-red-500/30 opacity-0 group-hover/err:opacity-100 transition-opacity z-50 pointer-events-none">
                    {trade.last_error}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </td>

      {/* Entry Price (T+5s) */}
      <td className="py-3 px-4 text-right">
        <span className="text-sm font-mono text-slate-300">{formatPrice(entryPrice)}</span>
        {trade.sol_spent > 0 && (
          <p className="text-[11px] text-slate-500 mt-0.5">{trade.sol_spent.toFixed(4)} SOL</p>
        )}
      </td>

      {/* Current Price */}
      <td className="py-3 px-4 text-right">
        <span className={`text-sm font-mono font-medium ${isOpen ? 'text-white' : 'text-slate-400'}`}>
          {formatPrice(trade.current_price || trade.sell_price_usd || entryPrice)}
        </span>
        <p className="text-[10px] text-slate-500 mt-0.5">MC: {formatMC(trade.current_mc || trade.buy_mc || trade.marketCap)}</p>
      </td>

      {/* ATH */}
      <td className="py-3 px-4 text-right">
        <div className="flex items-center justify-end gap-1">
          <TrendingUp className="w-3 h-3 text-amber-400" />
          <span className="text-sm font-mono text-amber-300">{formatPrice(trade.ath_usd)}</span>
        </div>
        {trade.ath_timestamp && (
          <p className="text-[10px] text-slate-600 mt-0.5">{timeAgo(trade.ath_timestamp)}</p>
        )}
      </td>

      {/* PnL */}
      <td className="py-3 px-4 text-right">
        <span className={`text-sm font-bold font-mono ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
          {formatPnl(pnl)}
        </span>
        <div className="pnl-bar mt-1.5 w-16 ml-auto">
          <div
            className="pnl-bar-fill"
            style={{
              width: `${barWidth}%`,
              background: isProfit
                ? 'linear-gradient(90deg, #10b981, #34d399)'
                : 'linear-gradient(90deg, #ef4444, #f87171)',
            }}
          />
        </div>
      </td>

      {/* Status */}
      <td className="py-3 px-4 text-center">
        <div className="flex flex-col items-center gap-1">
          <span className={`badge ${getStatusBadge(trade)}`}>
            {isOpen && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
            {getStatusLabel(trade)}
          </span>
          {isOpen && (
            <button
              onClick={() => { if (confirm('Vendre cette position ?')) api.sellTrade(trade.id); }}
              className="text-[10px] text-indigo-400 hover:text-white hover:underline transition-colors"
            >
              Vendre manuel
            </button>
          )}
          {trade.sell_attempts > 0 && trade.status !== 'CLOSED' && (
            <span className="text-[9px] text-amber-500">Retry {trade.sell_attempts}x</span>
          )}
        </div>
      </td>

      {/* Time */}
      <td className="py-3 px-4 text-right text-xs text-slate-500">
        {timeAgo(trade.created_at)}
      </td>
    </tr>
  );
};

// ─── WalletManager ───────────────────────────────────────────────────────────

const WalletManager = ({ wallets, onRefresh, onClickWallet }) => {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const addWallet = async (e) => {
    e.preventDefault();
    if (!address) return;
    setLoading(true);
    try {
      await api.addWallet(address, label);
      setAddress(''); setLabel('');
      onRefresh();
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const removeWallet = async (id) => {
    if (!confirm('Supprimer ce wallet ?')) return;
    try { await api.deleteWallet(id); onRefresh(); }
    catch (err) { alert(err.message); }
  };

  return (
    <div className="glass-card p-5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Wallet className="w-5 h-5 text-purple-400" />
          <h3 className="font-semibold text-white">Wallets Surveillés ({wallets.length})</h3>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-4 space-y-4 animate-fade-in-up">
          <form onSubmit={addWallet} className="space-y-3">
            <input
              type="text" value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder="Adresse Solana..."
              className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
            />
            <input
              type="text" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optionnel)"
              className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
            />
            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition-all text-sm flex items-center justify-center gap-2">
              <Plus className="w-4 h-4" />
              {loading ? 'Ajout...' : 'Ajouter'}
            </button>
          </form>

          <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar">
            {wallets.map(w => (
              <div
                key={w.id}
                onClick={() => onClickWallet?.(w.address)}
                className="flex items-center justify-between p-3 rounded-xl bg-black/20 border border-white/5 hover:border-indigo-500/30 transition-all group cursor-pointer"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-200 truncate">{w.label || 'Sans nom'}</p>
                  <p className="text-[11px] font-mono text-slate-500 truncate">{w.address}</p>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">Voir tokens</span>
                  <button onClick={(e) => { e.stopPropagation(); removeWallet(w.id); }} className="p-1.5 text-slate-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all opacity-0 group-hover:opacity-100">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {wallets.length === 0 && <p className="text-center text-slate-600 text-sm py-4">Aucun wallet ajouté</p>}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── WalletDetailModal ───────────────────────────────────────────────────────

const WalletDetailModal = ({ address, onClose }) => {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    setDetail(null);
    api.getWalletDetail(address)
      .then(data => setDetail(data))
      .catch(err => console.error('Wallet detail error:', err))
      .finally(() => setLoading(false));
  }, [address]);

  if (!address) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-[var(--bg-card)] border border-white/[0.08] rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden shadow-2xl flex flex-col animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-white/[0.05] flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-xl font-bold text-white">Détails du Wallet</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs font-mono text-slate-500">{address}</span>
              <CopyButton text={address} />
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-white transition-colors text-lg">✕</button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
          {loading ? (
            <div className="py-16 flex flex-col items-center gap-4">
              <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-slate-400 text-sm">Chargement des données...</p>
            </div>
          ) : detail ? (
            <div className="space-y-6">
              {/* Balance */}
              <div className="bg-black/30 p-5 rounded-xl border border-white/[0.06] flex items-center justify-between">
                <div>
                  <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Balance SOL</p>
                  <p className="text-3xl font-bold text-white">
                    {(detail.balance || 0).toFixed(4)}
                    <span className="text-indigo-400 text-base ml-2">SOL</span>
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center">
                  <Wallet className="w-6 h-6 text-indigo-400" />
                </div>
              </div>

              {/* Tokens list */}
              <div>
                <h3 className="text-base font-semibold mb-4 flex items-center gap-2 text-white">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                  10 Derniers Tokens Achetés
                </h3>
                <div className="space-y-2">
                  {(!detail.tokens || detail.tokens.length === 0) ? (
                    <p className="text-slate-500 text-sm text-center py-8">Aucun token trouvé pour ce wallet.</p>
                  ) : (
                    detail.tokens.map((token, idx) => (
                      <div key={idx} className="bg-black/20 p-4 rounded-xl border border-white/[0.05] hover:border-white/[0.1] transition-all flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500/20 to-cyan-500/20 border border-purple-500/20 flex items-center justify-center text-xs font-bold text-purple-300 flex-shrink-0">
                            {(token.symbol || '?')[0]}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="badge badge-jupiter text-[10px]">{token.symbol || '???'}</span>
                              <span className="text-sm font-medium text-white truncate">{token.name || 'Unknown'}</span>
                            </div>
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className="text-[10px] font-mono text-slate-600 truncate">{shortAddr(token.mint, 8)}</span>
                              <CopyButton text={token.mint} />
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {token.priceUsd && (
                            <span className="text-xs font-mono text-slate-400">${Number(token.priceUsd).toFixed(6)}</span>
                          )}
                          <a
                            href={`https://axiom.trade/meme/${token.mint}?chain=sol`}
                            target="_blank" rel="noreferrer"
                            className="px-3 py-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 rounded-lg transition-all"
                          >
                            Details
                          </a>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-center py-16 text-slate-500">Impossible de charger les données.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/[0.05] flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-white/5 hover:bg-white/10 text-white rounded-xl transition-colors text-sm font-medium"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [botConfig, setBotConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedWallet, setSelectedWallet] = useState(null);
  const prevPrices = useRef({});

  // ── Fetch data ─────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const [t, s, w, c] = await Promise.all([
        api.getRecentTrades(10),
        api.getTradeStats(),
        api.getWallets(),
        api.getConfig(),
      ]);
      setTrades(t);
      setStats(s);
      setWallets(w);
      setBotConfig(c);
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // ── WebSocket live updates ─────────────────────────────────────────────
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

  // ── Render ─────────────────────────────────────────────────────────────
  const openCount = stats?.openTrades ?? 0;
  const totalPnl = stats?.totalPnlUsd ?? 0;
  const winRate = stats?.winRate ?? '0.0';

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="border-b border-white/[0.05] bg-[var(--bg-secondary)]/60 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Thor</h1>
              <p className="text-[11px] text-slate-500 font-medium">Copy-Trading • Solana</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {botConfig && (
              <div className="hidden md:flex items-center gap-3 text-xs text-slate-400">
                <span className="px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                  TP +{botConfig.tpPercent}%
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                  SL {botConfig.slPercent}%
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                  {botConfig.buyAmountEur}€/trade
                </span>
                {botConfig.dryRun && (
                  <span className="px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 font-semibold">
                    DRY RUN
                  </span>
                )}
              </div>
            )}

            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${isConnected
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
              : 'border-red-500/20 bg-red-500/10 text-red-400'
              }`}>
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {isConnected ? 'Live' : 'Offline'}
            </div>

            <button onClick={fetchAll} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors" title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-8 space-y-8">
        {/* ── Stats Bar ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            icon={BarChart3} label="Total Trades" color="text-indigo-400"
            value={stats?.totalTrades ?? 0}
            sub={`${stats?.closedTrades ?? 0} fermés`}
          />
          <StatCard
            icon={Target} label="Win Rate" color="text-emerald-400"
            value={`${winRate}%`}
            sub={`${stats?.wins ?? 0} TP atteints`}
          />
          <StatCard
            icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
            label="PnL Total" color={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
            value={totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`}
            sub={`${(stats?.totalSolSpent ?? 0).toFixed(2)} SOL investi`}
          />
          <StatCard
            icon={Activity} label="Positions Ouvertes" color="text-amber-400"
            value={openCount}
            sub={`${wallets.length} wallets surveillés`}
          />
        </div>

        {/* ── Main Grid ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Trades Table — 3 cols */}
          <div className="lg:col-span-3">
            <div className="glass-card overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-5 h-5 text-indigo-400" />
                  <h2 className="text-lg font-semibold text-white">10 Derniers Trades</h2>
                </div>
                {trades.some(t => t.status === 'OPEN') && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    {trades.filter(t => t.status === 'OPEN').length} actif(s)
                  </span>
                )}
              </div>

              {loading ? (
                <div className="p-8 space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="skeleton h-14 w-full" />
                  ))}
                </div>
              ) : trades.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                  <BarChart3 className="w-12 h-12 mb-4 opacity-20" />
                  <p className="font-medium">Aucun trade détecté</p>
                  <p className="text-sm text-slate-600 mt-1">Les trades apparaîtront ici quand un wallet surveillé trade</p>
                </div>
              ) : (
                <div className="overflow-x-auto custom-scrollbar">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider border-b border-white/[0.05]">
                        <th className="py-3 px-4">Token</th>
                        <th className="py-3 px-4 text-right">Prix Entrée</th>
                        <th className="py-3 px-4 text-right">Prix Actuel</th>
                        <th className="py-3 px-4 text-right">ATH</th>
                        <th className="py-3 px-4 text-right">PnL</th>
                        <th className="py-3 px-4 text-center">Statut</th>
                        <th className="py-3 px-4 text-right">Temps</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((trade, idx) => (
                        <TradeRow key={trade.id || idx} trade={trade} index={idx} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar — 1 col */}
          <div className="space-y-6">
            <WalletManager wallets={wallets} onRefresh={fetchAll} onClickWallet={(addr) => setSelectedWallet(addr)} />

            {/* Config Summary */}
            {botConfig && (
              <div className="glass-card p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Settings className="w-5 h-5 text-slate-400" />
                  <h3 className="font-semibold text-white">Configuration</h3>
                </div>
                <div className="space-y-2.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Auto-buy</span>
                    <span className={`font-medium ${botConfig.autoBuyEnabled ? 'text-emerald-400' : 'text-red-400'}`}>
                      {botConfig.autoBuyEnabled ? 'Actif' : 'Inactif'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Montant</span>
                    <span className="text-white font-medium">{botConfig.buyAmountEur}€ / trade</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Slippage</span>
                    <span className="text-white font-medium">{botConfig.slippageBps / 100}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Take Profit</span>
                    <span className="text-emerald-400 font-medium">+{botConfig.tpPercent}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Stop Loss</span>
                    <span className="text-red-400 font-medium">{botConfig.slPercent}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Max Priority Fee</span>
                    <span className="text-white font-medium">{botConfig.maxPriorityFeeEur}€</span>
                  </div>
                  {botConfig.walletAddress && (
                    <div className="pt-2 mt-2 border-t border-white/[0.05]">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Wallet</span>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs text-slate-300">{shortAddr(botConfig.walletAddress, 6)}</span>
                          <CopyButton text={botConfig.walletAddress} />
                        </div>
                      </div>
                    </div>
                  )}
                  {!botConfig.walletConfigured && (
                    <div className="mt-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div className="flex items-center gap-2 text-amber-400 text-xs">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Clé privée non configurée. Auto-buy désactivé.</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Wallet Detail Modal */}
      {selectedWallet && (
        <WalletDetailModal address={selectedWallet} onClose={() => setSelectedWallet(null)} />
      )}

      <footer className="border-t border-white/[0.03] mt-12 py-6 text-center text-xs text-slate-600">
        Thor v2 • Copy-Trading Bot • Solana
      </footer>
    </div>
  );
}
