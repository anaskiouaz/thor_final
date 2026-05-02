import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Copy, Check, ExternalLink, TrendingUp, AlertTriangle, 
  BarChart3, History
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer 
} from 'recharts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatPrice(p) {
  if (!p || p === 0) return '$0.00';
  if (p < 0.0001) return `$${p.toExponential(2)}`;
  if (p < 1) return `$${p.toFixed(6)}`;
  return `$${p.toFixed(2)}`;
}

export function formatPnl(pct) {
  if (pct == null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export function shortAddr(addr, len = 4) {
  if (!addr) return '—';
  return `${addr.slice(0, len)}...${addr.slice(-len)}`;
}

export function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function getDexBadgeClass(dex) {
  if (!dex) return 'badge-pending';
  if (dex.includes('pump')) return 'badge-pumpfun';
  if (dex.includes('ray')) return 'badge-raydium';
  if (dex.includes('jup')) return 'badge-jupiter';
  return 'badge-pending';
}

export function getStatusBadge(trade) {
  if (trade.status === 'OPEN') return 'badge-open';
  if (trade.status === 'PENDING') return 'badge-pending';
  if (trade.sell_reason === 'TP') return 'badge-tp';
  if (trade.sell_reason === 'SL') return 'badge-sl';
  return 'badge-closed';
}

export function getStatusLabel(trade) {
  if (trade.status === 'OPEN') return 'OPEN';
  if (trade.status === 'PENDING') return 'PENDING...';
  if (trade.status === 'BUY_FAILED') return 'BUY FAILED';
  if (trade.sell_reason === 'TP') return 'TP ✓';
  if (trade.sell_reason === 'SL') return 'SL ✗';
  return trade.sell_reason || 'CLOSED';
}

export function formatMC(val) {
  if (!val || val === 0) return '—';
  if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `$${(val / 1000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

// ─── CopyButton ──────────────────────────────────────────────────────────────

export const CopyButton = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 hover:bg-white/10 rounded-lg transition-all text-slate-500 hover:text-white"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
};

// ─── PnlChart ────────────────────────────────────────────────────────────────

export const PnlChart = ({ trades }) => {
  const data = trades
    .slice()
    .reverse()
    .map((t, i) => ({
      name: i + 1,
      pnl: t.pnl_pct || 0,
      symbol: t.token_symbol || '?'
    }));

  if (data.length < 2) return (
    <div className="h-[200px] flex items-center justify-center text-slate-500 text-sm">
      Pas assez de données pour le graphique
    </div>
  );

  return (
    <div className="h-[240px] w-full mt-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis 
            dataKey="name" 
            stroke="rgba(255,255,255,0.2)" 
            fontSize={10} 
            tickLine={false}
            axisLine={false}
          />
          <YAxis 
            stroke="rgba(255,255,255,0.2)" 
            fontSize={10} 
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => `${value}%`}
          />
          <ChartTooltip 
            contentStyle={{ backgroundColor: '#111827', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
            itemStyle={{ color: '#818cf8' }}
          />
          <Area 
            type="monotone" 
            dataKey="pnl" 
            stroke="#6366f1" 
            strokeWidth={3}
            fillOpacity={1} 
            fill="url(#colorPnl)" 
            animationDuration={1500}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

// ─── TradeRow ────────────────────────────────────────────────────────────────

export const TradeRow = ({ trade, index }) => {
  const entryPrice = trade.entry_price_usd || trade.buy_price_usd || 0;
  const pnl = trade.pnl_pct || 0;
  const isProfit = pnl >= 0;
  const isOpen = trade.status === 'OPEN';
  const isNew = (Date.now() - new Date(trade.created_at).getTime()) < 60000;

  // PnL bar width (clamped -100 to +200)
  const barWidth = Math.min(100, Math.max(0, (pnl + 100) / 3));

  return (
    <motion.tr
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
      className={`group border-b border-white/[0.03] hover:bg-white/[0.04] transition-all relative ${isNew ? 'bg-indigo-500/5' : ''}`}
    >
      {/* Token */}
      <td className="py-4 px-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-sm font-black text-indigo-300 shadow-inner ${isNew ? 'animate-pulse' : ''}`}>
            {(trade.token_symbol || '?')[0]}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-sm tracking-tight">{trade.token_symbol || '???'}</span>
              <span className={`badge ${getDexBadgeClass(trade.dex_used)}`}>{(trade.dex_used || 'unknown').replace('_dry', '')}</span>
              {isNew && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-indigo-500 text-white animate-pulse">NEW</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[11px] font-mono text-slate-500">{shortAddr(trade.token_address, 6)}</span>
              <CopyButton text={trade.token_address} />
              <a href={`https://solscan.io/token/${trade.token_address}`} target="_blank" rel="noreferrer"
                className="text-slate-600 hover:text-indigo-400 transition-colors">
                <ExternalLink className="w-3 h-3" />
              </a>
              {trade.last_error && (
                <div className="group/err relative">
                  <AlertTriangle className="w-3 h-3 text-red-400 cursor-help" />
                  <div className="absolute bottom-full left-0 mb-2 w-48 p-2 bg-red-900/95 backdrop-blur-md text-white text-[10px] rounded-lg border border-red-500/30 shadow-2xl opacity-0 group-hover/err:opacity-100 transition-opacity z-50 pointer-events-none">
                    {trade.last_error}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </td>

      {/* Entry Price */}
      <td className="py-4 px-4 text-right">
        <span className="text-sm font-mono font-bold text-slate-300">{formatPrice(entryPrice)}</span>
        {trade.sol_spent > 0 && (
          <p className="text-[11px] text-slate-500 mt-1 font-medium">{trade.sol_spent.toFixed(4)} SOL</p>
        )}
      </td>

      {/* Current Price */}
      <td className="py-4 px-4 text-right">
        <span className={`text-sm font-mono font-black ${isOpen ? 'text-white text-glow-indigo' : 'text-slate-400'}`}>
          {formatPrice(trade.current_price || trade.sell_price_usd || entryPrice)}
        </span>
        <p className="text-[10px] text-slate-500 mt-1 font-medium italic">MC: {formatMC(trade.current_mc || trade.buy_mc || trade.marketCap)}</p>
      </td>

      {/* ATH */}
      <td className="py-4 px-4 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-sm font-mono font-bold text-amber-300">{formatPrice(trade.ath_usd)}</span>
        </div>
        {trade.ath_timestamp && (
          <p className="text-[10px] text-slate-600 mt-1 font-medium">{timeAgo(trade.ath_timestamp)}</p>
        )}
      </td>

      {/* PnL */}
      <td className="py-4 px-4 text-right">
        <motion.span 
          key={pnl}
          initial={{ scale: 1.2, color: '#fff' }}
          animate={{ scale: 1, color: isProfit ? '#34d399' : '#f87171' }}
          className={`text-sm font-black font-mono ${isProfit ? 'text-glow-emerald' : ''}`}
        >
          {formatPnl(pnl)}
        </motion.span>
        <div className="pnl-bar mt-2 w-16 ml-auto bg-white/5">
          <motion.div
            className="pnl-bar-fill"
            initial={{ width: 0 }}
            animate={{ width: `${barWidth}%` }}
            style={{
              background: isProfit
                ? 'linear-gradient(90deg, #10b981, #34d399)'
                : 'linear-gradient(90deg, #ef4444, #f87171)',
              boxShadow: isProfit ? '0 0 10px rgba(16, 185, 129, 0.4)' : '0 0 10px rgba(239, 68, 68, 0.4)'
            }}
          />
        </div>
      </td>
      
      {/* Engine Status / Stages */}
      <td className="py-4 px-4 text-center">
        <div className="flex flex-col items-center gap-2">
          <span className={`badge ${getStatusBadge(trade)} px-3 py-1`}>
            {isOpen && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-1" />}
            {getStatusLabel(trade)}
          </span>
          
          {isOpen && (
            <div className="flex items-center gap-1.5 mt-1">
              {[1, 2, 3].map(s => (
                <div 
                  key={s} 
                  title={s === 3 ? 'Moonbag' : `TP${s}`}
                  className={`w-2 h-2 rounded-full transition-all duration-500 border ${
                    trade.current_stage >= s 
                      ? 'bg-emerald-400 border-emerald-400 shadow-[0_0_8px_#10b981]' 
                      : 'bg-white/5 border-white/10'
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </td>

      {/* Time */}
      <td className="py-4 px-8 text-right">
        <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest opacity-60">
          {timeAgo(trade.created_at)}
        </span>
      </td>
    </motion.tr>
  );
};

const TradeTable = ({ trades, loading }) => {
  return (
    <div className="glass-card overflow-hidden">
      <div className="px-8 py-6 border-b border-white/[0.05] flex items-center justify-between bg-white/[0.01]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 border border-indigo-500/20">
            <History className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-black text-white tracking-tight">Flux de Trading Live</h2>
            <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Dernières activités de l'intelligence artificielle</p>
          </div>
        </div>
        {trades.some(t => t.status === 'OPEN') && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-400 font-black uppercase tracking-widest">
              {trades.filter(t => t.status === 'OPEN').length} Positions Actives
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="p-8 space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : trades.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-28 text-slate-500">
          <motion.div
            animate={{ y: [0, -10, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            <BarChart3 className="w-20 h-20 mb-6 opacity-10" />
          </motion.div>
          <p className="font-black text-xl text-slate-400 tracking-tight">Système en attente de détection</p>
          <p className="text-sm text-slate-600 mt-2 font-medium">Les trades de vos wallets cibles s'afficheront ici instantanément</p>
        </div>
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] border-b border-white/[0.05] bg-white/[0.01]">
                <th className="py-5 px-8">Token / Asset</th>
                <th className="py-5 px-4 text-right">Entry Point</th>
                <th className="py-5 px-4 text-right">Market Value</th>
                <th className="py-5 px-4 text-right">High Point</th>
                <th className="py-5 px-4 text-right">Net Return</th>
                <th className="py-5 px-4 text-center">Engine Status</th>
                <th className="py-5 px-8 text-right">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.02]">
              <AnimatePresence mode="popLayout">
                {trades.map((trade, idx) => (
                  <TradeRow key={trade.id || idx} trade={trade} index={idx} />
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default TradeTable;
