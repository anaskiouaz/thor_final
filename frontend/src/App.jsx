import React, { useState } from 'react';
import { Zap, RefreshCw, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Components
import StatsHeader from './components/StatsHeader';
import TradeTable, { PnlChart } from './components/TradeTable';
import WalletCard from './components/WalletCard';
import SettingsModal from './components/SettingsModal';
import WalletDetailModal from './components/WalletDetailModal';

// Hooks
import { useTrades } from './hooks/useTrades';
import { useWallets } from './hooks/useWallets';
import { isSimulation, setSessionPort } from './lib/session';

export default function App() {
  const simulation = isSimulation();
  const { trades, stats, loading: tradesLoading, isConnected, refresh: refreshTrades } = useTrades();
  const { wallets, botConfig, setBotConfig, refresh: refreshWallets, toggleDryRun } = useWallets();
  const [selectedWallet, setSelectedWallet] = useState(null);

  const fetchAll = () => {
    refreshTrades();
    refreshWallets();
  };

  return (
    <div className={`min-h-screen bg-[var(--bg-primary)] selection:bg-indigo-500/30 transition-all duration-700 ${
      simulation 
        ? 'shadow-[inset_0_0_100px_rgba(59,130,246,0.15)] ring-4 ring-blue-500/20 ring-inset' 
        : 'shadow-[inset_0_0_100px_rgba(239,68,68,0.15)] ring-4 ring-red-500/20 ring-inset'
    }`}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="border-b border-white/[0.05] bg-[var(--bg-secondary)]/80 backdrop-blur-2xl sticky top-0 z-40">
        <div className="max-w-[1600px] mx-auto px-8 py-5 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <motion.div 
              animate={{ rotate: 360 }}
              transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-2xl relative group ${
                simulation 
                  ? 'bg-gradient-to-br from-blue-600 to-cyan-600 shadow-blue-500/40' 
                  : 'bg-gradient-to-br from-red-600 to-orange-600 shadow-red-500/40'
              }`}
            >
              <Zap className="w-6 h-6 text-white" />
              <div className="absolute inset-0 rounded-2xl bg-white/20 opacity-0 group-hover:opacity-10 transition-opacity" />
            </motion.div>
            <div>
              <h1 className="text-2xl font-black tracking-tighter text-white flex items-center gap-2">
                THOR - <span className={simulation ? 'text-blue-400' : 'text-red-500'}>{simulation ? 'SIMULATION' : 'RÉEL'}</span>
                <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded text-slate-400 font-black tracking-widest align-middle">V2.5</span>
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`w-1.5 h-1.5 rounded-full ${simulation ? 'bg-blue-500 shadow-[0_0_8px_#3b82f6]' : 'bg-red-500 shadow-[0_0_8px_#ef4444]'}`} />
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Neural Copy-Trading Engine</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className={`flex items-center gap-1 p-1 rounded-2xl bg-white/[0.03] border ${simulation ? 'border-blue-500/30' : 'border-red-500/30'}`}>
              <button
                onClick={() => setSessionPort(3001)}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all duration-300 ${
                  simulation
                    ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]'
                    : 'text-slate-500 hover:text-white hover:bg-white/5 font-bold'
                }`}
              >
                Session Simulation
              </button>
              <button
                onClick={() => setSessionPort(3000)}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all duration-300 ${
                  !simulation
                    ? 'bg-red-600 text-white shadow-[0_0_15px_rgba(220,38,38,0.4)]'
                    : 'text-slate-500 hover:text-white hover:bg-white/5 font-bold'
                }`}
              >
                Session Réelle
              </button>
            </div>

            <div className="h-8 w-px bg-white/10 mx-2" />

            {botConfig && (
              <div className="hidden lg:flex items-center gap-4">
                <div className="flex flex-col items-end">
                  <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Risk Config</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-1 rounded-md bg-white/[0.03] border border-white/[0.06] text-[10px] font-bold text-slate-400">
                      TP <span className="text-emerald-400">+{botConfig.tpPercent}%</span>
                    </span>
                    <span className="px-2 py-1 rounded-md bg-white/[0.03] border border-white/[0.06] text-[10px] font-bold text-slate-400">
                      SL <span className="text-red-400">{botConfig.slPercent}%</span>
                    </span>
                  </div>
                </div>
                <div className="h-8 w-px bg-white/10" />
                <div className="flex flex-col items-end">
                  <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Trade Size</span>
                  <span className="text-sm font-black text-white mt-0.5">{botConfig.buyAmountEur}€</span>
                </div>
              </div>
            )}

            <div className={`flex items-center gap-2.5 px-4 py-2 rounded-full border-2 text-xs font-black uppercase tracking-widest transition-all ${isConnected
              ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.1)]'
              : 'border-red-500/20 bg-red-500/5 text-red-400'
              }`}>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 shadow-[0_0_8px_#10b981] animate-pulse' : 'bg-red-400'}`} />
              {isConnected ? 'Network Live' : 'Disconnected'}
            </div>

            <button onClick={fetchAll} className="p-2.5 rounded-xl hover:bg-white/5 text-slate-400 hover:text-white transition-all hover:rotate-180 duration-500" title="Refresh">
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-8 py-10 space-y-10">
        <StatsHeader stats={stats} wallets={wallets} />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Main Content — 9 cols */}
          <div className="lg:col-span-9 space-y-8">
            {/* Chart Section */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="glass-card p-8 bg-gradient-to-br from-indigo-500/[0.05] to-transparent"
            >
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-xl font-black text-white tracking-tight">Analyse de Performance</h3>
                  <p className="text-xs text-slate-500 font-medium uppercase tracking-widest mt-1">PnL % des derniers trades détectés</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] font-black tracking-widest uppercase">
                    <Zap size={14} className="w-3.5 h-3.5" /> Dynamique
                  </div>
                </div>
              </div>
              <PnlChart trades={trades} />
            </motion.div>

            <TradeTable trades={trades} loading={tradesLoading} />
          </div>

          {/* Sidebar — 3 cols */}
          <div className="lg:col-span-3 space-y-8">
            <WalletCard wallets={wallets} onRefresh={refreshWallets} onClickWallet={setSelectedWallet} />
            
            <SettingsModal botConfig={botConfig} setBotConfig={setBotConfig} />
            
            {/* Quick Actions / Info */}
            <div className="glass-card p-6 bg-indigo-600/[0.03] border-indigo-500/10">
              <div className="flex items-center gap-3 mb-4">
                <Shield className="w-5 h-5 text-indigo-400" />
                <h4 className="text-xs font-black text-white uppercase tracking-widest">Sécurité Thor</h4>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
                Toutes les transactions sont filtrées par notre moteur d'analyse anti-rug. Les fonds ne quittent jamais votre wallet Solana personnel.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Wallet Detail Modal */}
      <AnimatePresence>
        {selectedWallet && (
          <WalletDetailModal address={selectedWallet} onClose={() => setSelectedWallet(null)} />
        )}
      </AnimatePresence>

      <footer className="border-t border-white/[0.03] py-12 text-center">
        <div className="flex items-center justify-center gap-2 text-slate-700">
          <Zap size={14} className="opacity-20" />
          <span className="text-[10px] font-black uppercase tracking-[0.4em]">Thor Neural System • Built for Alpha</span>
        </div>
      </footer>
    </div>
  );
}
