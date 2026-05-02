import React from 'react';
import { motion } from 'framer-motion';
import { Settings, AlertTriangle } from 'lucide-react';
import * as api from '../lib/api';
import { shortAddr, CopyButton } from './TradeTable';

const SettingsModal = ({ botConfig, setBotConfig }) => {
  if (!botConfig) return null;

  return (
    <motion.div 
      whileHover={{ scale: 1.02 }}
      className="glass-card relative overflow-hidden group"
    >
      <div className="absolute top-0 right-0 p-8 opacity-0 group-hover:opacity-10 transition-opacity">
        <Settings size={120} />
      </div>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-slate-500/10 flex items-center justify-center text-slate-400 border border-white/10">
            <Settings className="w-5 h-5" />
          </div>
          <h3 className="font-black text-white tracking-tight uppercase text-sm">Paramètres Bot</h3>
        </div>
        <div className="space-y-4">
          {/* Auto-Execution */}
          <div className="flex justify-between items-center group/item">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest group-hover/item:text-slate-400 transition-colors">Auto-Execution</span>
            <button
              onClick={async () => {
                const nextVal = !botConfig.autoBuyEnabled;
                setBotConfig(prev => ({ ...prev, autoBuyEnabled: nextVal }));
                await api.updateConfig({ autoBuyEnabled: nextVal });
              }}
              className={`px-2.5 py-1 rounded text-xs font-black uppercase tracking-widest transition-all ${
                botConfig.autoBuyEnabled 
                  ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' 
                  : 'bg-red-500/10 border border-red-500/20 text-red-400'
              }`}
            >
              {botConfig.autoBuyEnabled ? 'Online' : 'Disabled'}
            </button>
          </div>

          {/* Trade Amount */}
          <div className="flex justify-between items-center group/item">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest group-hover/item:text-slate-400 transition-colors">Trade Amount</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={botConfig.buyAmountEur || ''}
                onChange={(e) => setBotConfig(p => ({ ...p, buyAmountEur: e.target.value }))}
                onBlur={async () => {
                  if (botConfig.buyAmountEur) await api.updateConfig({ buyAmountEur: botConfig.buyAmountEur });
                }}
                className="w-16 bg-black/40 border border-white/10 rounded px-2 py-1 text-right text-xs font-black focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <span className="text-xs font-bold text-slate-400">€</span>
            </div>
          </div>

          {/* Max Slippage */}
          <div className="flex justify-between items-center group/item">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest group-hover/item:text-slate-400 transition-colors">Max Slippage</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={botConfig.slippageBps ? botConfig.slippageBps / 100 : ''}
                onChange={(e) => setBotConfig(p => ({ ...p, slippageBps: e.target.value * 100 }))}
                onBlur={async () => {
                  if (botConfig.slippageBps) await api.updateConfig({ slippageBps: botConfig.slippageBps });
                }}
                className="w-16 bg-black/40 border border-white/10 rounded px-2 py-1 text-right text-xs font-black focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <span className="text-xs font-bold text-slate-400">%</span>
            </div>
          </div>

          {/* Take Profit */}
          <div className="flex justify-between items-center group/item">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest group-hover/item:text-slate-400 transition-colors">Take Profit</span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-emerald-400">+</span>
              <input
                type="number"
                value={botConfig.tpPercent || ''}
                onChange={(e) => setBotConfig(p => ({ ...p, tpPercent: e.target.value }))}
                onBlur={async () => {
                  if (botConfig.tpPercent) await api.updateConfig({ tpPercent: botConfig.tpPercent });
                }}
                className="w-16 bg-black/40 border border-white/10 rounded px-2 py-1 text-right text-xs font-black text-emerald-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <span className="text-xs font-bold text-slate-400">%</span>
            </div>
          </div>

          {/* Stop Loss */}
          <div className="flex justify-between items-center group/item">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest group-hover/item:text-slate-400 transition-colors">Stop Loss</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={botConfig.slPercent || ''}
                onChange={(e) => setBotConfig(p => ({ ...p, slPercent: e.target.value }))}
                onBlur={async () => {
                  if (botConfig.slPercent) await api.updateConfig({ slPercent: botConfig.slPercent });
                }}
                className="w-16 bg-black/40 border border-white/10 rounded px-2 py-1 text-right text-xs font-black text-red-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <span className="text-xs font-bold text-slate-400">%</span>
            </div>
          </div>

          {/* Gas Priority */}
          <div className="flex justify-between items-center group/item">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest group-hover/item:text-slate-400 transition-colors">Gas Priority</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={botConfig.maxPriorityFeeEur || ''}
                onChange={(e) => setBotConfig(p => ({ ...p, maxPriorityFeeEur: e.target.value }))}
                onBlur={async () => {
                  if (botConfig.maxPriorityFeeEur) await api.updateConfig({ maxPriorityFeeEur: botConfig.maxPriorityFeeEur });
                }}
                className="w-16 bg-black/40 border border-white/10 rounded px-2 py-1 text-right text-xs font-black focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <span className="text-xs font-bold text-slate-400">€</span>
            </div>
          </div>
          
          {botConfig.walletAddress && (
            <div className="pt-4 mt-2 border-t border-white/[0.05]">
              <div className="flex items-center justify-between bg-black/30 p-3 rounded-xl border border-white/5">
                <div className="flex flex-col">
                  <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Active Wallet</span>
                  <span className="font-mono text-[10px] text-indigo-300 mt-0.5">{shortAddr(botConfig.walletAddress, 8)}</span>
                </div>
                <CopyButton text={botConfig.walletAddress} />
              </div>
            </div>
          )}
          
          {!botConfig.walletConfigured && (
            <motion.div 
              animate={{ x: [-2, 2, -2] }}
              transition={{ duration: 0.5, repeat: Infinity }}
              className="mt-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20"
            >
              <div className="flex items-start gap-3 text-red-400">
                <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-black uppercase tracking-widest">Alerte Sécurité</p>
                  <p className="text-[10px] font-medium mt-1 leading-relaxed opacity-80">Clé privée non détectée dans l'environnement.</p>
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default SettingsModal;
