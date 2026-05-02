import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Wallet, Activity, History, Eye, ExternalLink, AlertTriangle, Zap, RefreshCw } from 'lucide-react';
import * as api from '../lib/api';
import { shortAddr, CopyButton } from './TradeTable';

const formatMC = (val) => {
  if (!val || val === 0) return 'N/A';
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
};

const WalletDetailModal = ({ address, onClose }) => {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState(null);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    setDetail(null);
    setAuditResult(null);
    api.getWalletDetail(address)
      .then(data => setDetail(data))
      .catch(err => console.error('Wallet detail error:', err))
      .finally(() => setLoading(false));
  }, [address]);

  const handleAudit = (force = false) => {
    setAuditing(true);
    api.getWalletAudit(address, force)
      .then(data => setAuditResult(data))
      .catch(err => console.error('Audit error:', err))
      .finally(() => setAuditing(false));
  };

  if (!address) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="bg-[#0c1220] border border-white/[0.08] rounded-3xl w-full max-w-2xl max-h-[85vh] overflow-hidden shadow-[0_0_50px_-12px_rgba(99,102,241,0.3)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-8 py-6 border-b border-white/[0.05] flex items-center justify-between flex-shrink-0 bg-white/[0.01]">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">Intelligence Wallet</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">{address}</span>
              <CopyButton text={address} />
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-xl text-slate-400 hover:text-white transition-colors">
            <Zap className="w-5 h-5 opacity-50" />
          </button>
        </div>

        {/* Content */}
        <div className="p-8 overflow-y-auto flex-1 custom-scrollbar space-y-8">
          {loading ? (
            <div className="py-24 flex flex-col items-center gap-6">
              <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin glow-indigo" />
              <p className="text-slate-500 text-xs font-black uppercase tracking-[0.2em]">Synchronisation des données...</p>
            </div>
          ) : detail ? (
            <div className="space-y-8">
              {/* Balance & Audit */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gradient-to-br from-indigo-500/10 to-purple-500/10 p-6 rounded-2xl border border-indigo-500/20 flex items-center justify-between relative overflow-hidden group">
                  <div className="absolute -right-4 -bottom-4 opacity-5 group-hover:scale-110 transition-transform">
                    <Wallet size={120} />
                  </div>
                  <div className="relative z-10">
                    <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1 opacity-60">Balance Réseau</p>
                    <p className="text-3xl font-black text-white tracking-tighter">
                      {(detail.balance || 0).toFixed(4)}
                      <span className="text-indigo-400 text-lg ml-2 font-bold tracking-normal uppercase">SOL</span>
                    </p>
                  </div>
                  <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shadow-lg shadow-indigo-500/10">
                    <Activity className="w-6 h-6 text-indigo-400" />
                  </div>
                </div>

                <div className="bg-black/20 p-6 rounded-2xl border border-white/[0.05] flex flex-col justify-center gap-3">
                  {!auditResult ? (
                    <button 
                      onClick={() => handleAudit(false)}
                      disabled={auditing}
                      className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-[10px] font-black uppercase tracking-[0.1em] transition-all flex items-center justify-center gap-2"
                    >
                      {auditing ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Audit des calls en cours...
                        </>
                      ) : (
                        <>
                          <Eye className="w-4 h-4" />
                          Auditer la qualité des calls (Top 5)
                        </>
                      )}
                    </button>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest">Score Alpha (Launch → ATH)</p>
                          <button 
                            onClick={() => handleAudit(true)} 
                            disabled={auditing}
                            className="text-slate-500 hover:text-indigo-400 transition-colors"
                            title="Forcer le rafraîchissement"
                          >
                            <RefreshCw className={`w-2.5 h-2.5 ${auditing ? 'animate-spin' : ''}`} />
                          </button>
                        </div>
                        <p className="text-2xl font-black text-white">
                          {auditResult.score}/{auditResult.total}
                          <span className="text-slate-500 text-xs ml-2 font-bold uppercase">Gagnants x2</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <div 
                            key={i} 
                            className={`w-2 h-2 rounded-full ${i < auditResult.score ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-white/10'}`} 
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Tokens list */}
              <div>
                <h3 className="text-xs font-black mb-5 flex items-center gap-2 text-white uppercase tracking-widest">
                  <History className="w-4 h-4 text-emerald-400" />
                  Historique des 10 Derniers Trades
                </h3>
                <div className="space-y-3">
                  {(!detail.tokens || detail.tokens.length === 0) ? (
                    <div className="text-center py-20 bg-black/20 rounded-2xl border border-white/[0.03]">
                      <Eye className="w-12 h-12 mx-auto mb-3 opacity-10" />
                      <p className="text-slate-500 text-xs font-bold uppercase tracking-widest">Aucune activité récente</p>
                    </div>
                  ) : (
                    detail.tokens.map((token, idx) => {
                      const tokenAudit = auditResult?.results?.find(r => r.mint === token.mint);
                      return (
                        <motion.div 
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          key={idx} 
                          className="bg-black/20 p-5 rounded-2xl border border-white/[0.03] hover:border-indigo-500/20 hover:bg-black/30 transition-all flex items-center justify-between gap-4 group"
                        >
                          <div className="flex items-center gap-4 min-w-0">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/10 to-cyan-500/10 border border-white/5 flex items-center justify-center text-sm font-black text-purple-300 flex-shrink-0 group-hover:scale-110 transition-transform">
                              {(token.symbol || '?')[0]}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-black text-white tracking-tight">{token.name || 'Unknown Asset'}</span>
                                <span className="badge badge-jupiter text-[9px] font-black">{token.symbol || '???'}</span>
                                {tokenAudit && (
                                  tokenAudit.isWinner ? (
                                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-[8px] font-black text-emerald-400 uppercase tracking-tighter">🔥 x2 Hit</span>
                                  ) : tokenAudit.isOld ? (
                                    <span className="px-2 py-0.5 rounded-full bg-slate-500/20 border border-white/10 text-[8px] font-black text-slate-500 uppercase tracking-tighter">Token &gt; 1 mois</span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/30 text-[8px] font-black text-red-400 uppercase tracking-tighter">💀 Dead</span>
                                  )
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 mt-1">
                                <span className="text-[10px] font-mono text-slate-600 truncate">{shortAddr(token.mint, 10)}</span>
                                <CopyButton text={token.mint} />
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 flex-shrink-0">
                            {tokenAudit && (tokenAudit.athMC || tokenAudit.launchMC) ? (
                              <div className="text-right">
                                <div className="mb-1">
                                  <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest leading-none">MC Sommet (ATH)</p>
                                  <p className="text-[11px] font-mono font-black text-emerald-400">
                                    {formatMC(tokenAudit.athMC)}
                                    {tokenAudit.source && (
                                      <span className="ml-1 text-[8px] text-slate-500 font-bold opacity-60">[{tokenAudit.source}]</span>
                                    )}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest leading-none">MC Lancement</p>
                                  <p className="text-[10px] font-mono font-bold text-slate-500">{formatMC(tokenAudit.launchMC)}</p>
                                </div>
                              </div>
                            ) : token.priceUsd ? (
                              <div className="text-right">
                                <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest mb-0.5">Price</p>
                                <p className="text-xs font-mono font-bold text-slate-400">${Number(token.priceUsd).toFixed(6)}</p>
                              </div>
                            ) : null}
                            <a
                              href={`https://axiom.trade/meme/${token.mint}?chain=sol`}
                              target="_blank" rel="noreferrer"
                              className="p-2.5 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 rounded-xl transition-all text-indigo-400 hover:text-white"
                            >
                              <ExternalLink size={16} />
                            </a>
                          </div>
                        </motion.div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-20">
              <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-red-500/50" />
              <p className="text-slate-500 text-sm font-bold uppercase tracking-widest">Échec de la récupération des données</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-6 border-t border-white/[0.05] flex justify-end flex-shrink-0 bg-white/[0.01]">
          <button
            onClick={onClose}
            className="px-8 py-3 bg-white/[0.03] hover:bg-white/[0.08] text-white rounded-2xl transition-all text-xs font-black uppercase tracking-widest border border-white/[0.05]"
          >
            Fermer l'interface
          </button>
        </div>
      </motion.div>
    </div>
  );
};

export default WalletDetailModal;
