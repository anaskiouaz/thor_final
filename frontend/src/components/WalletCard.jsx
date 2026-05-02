import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wallet, ChevronDown, Plus, Edit2, Trash2, History } from 'lucide-react';
import * as api from '../lib/api';

const WalletCard = ({ wallets, onRefresh, onClickWallet }) => {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

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

  const saveLabel = async (id) => {
    try {
      await api.updateWalletLabel(id, editValue);
      setEditingId(null);
      onRefresh();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="glass-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-5 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-400 border border-purple-500/20 glow-purple">
            <Wallet className="w-5 h-5" />
          </div>
          <div className="text-left">
            <h3 className="font-bold text-white tracking-tight">Wallets Surveillés</h3>
            <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest">{wallets.length} Actifs</p>
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-slate-500 transition-transform duration-500 ${expanded ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-white/[0.05]"
          >
            <div className="p-5 space-y-5">
              <form onSubmit={addWallet} className="space-y-3 bg-black/20 p-4 rounded-2xl border border-white/[0.03]">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Ajouter nouveau</label>
                  <input
                    type="text" value={address} onChange={(e) => setAddress(e.target.value)}
                    placeholder="Adresse Solana..."
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all font-mono"
                  />
                  <input
                    type="text" value={label} onChange={(e) => setLabel(e.target.value)}
                    placeholder="Label / Alias"
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
                  />
                </div>
                <button type="submit" disabled={loading}
                  className="w-full bg-premium hover:opacity-90 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-all text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20">
                  <Plus className="w-4 h-4" />
                  {loading ? 'AJOUT...' : 'SURVEILLER'}
                </button>
              </form>

              <div className="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                {wallets.map(w => (
                  <motion.div
                    layout
                    key={w.id}
                    className="flex items-center justify-between p-4 rounded-xl bg-black/20 border border-white/[0.03] hover:border-indigo-500/30 transition-all group relative"
                  >
                    <div className="min-w-0 flex-1" onClick={() => onClickWallet?.(w.address)}>
                      {editingId === w.id ? (
                        <div className="flex items-center gap-2 mb-1" onClick={e => e.stopPropagation()}>
                          <input 
                            autoFocus
                            value={editValue} 
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={() => saveLabel(w.id)}
                            onKeyDown={e => e.key === 'Enter' && saveLabel(w.id)}
                            className="bg-indigo-500/10 border border-indigo-500/30 rounded px-2 py-0.5 text-sm text-white focus:outline-none w-full"
                          />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-sm font-bold text-slate-200 truncate group-hover:text-white transition-colors">{w.label || 'Sans nom'}</p>
                          <button 
                            onClick={(e) => { e.stopPropagation(); setEditingId(w.id); setEditValue(w.label || ''); }}
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-indigo-400 transition-all"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                      <p className="text-[10px] font-mono text-slate-600 truncate">{w.address}</p>
                    </div>
                    <div className="flex items-center gap-1 ml-2">
                      <button onClick={(e) => { e.stopPropagation(); removeWallet(w.id); }} className="p-2 text-slate-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all opacity-0 group-hover:opacity-100">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </motion.div>
                ))}
                {wallets.length === 0 && (
                  <div className="text-center py-10 opacity-30">
                    <History className="w-10 h-10 mx-auto mb-2" />
                    <p className="text-xs font-bold uppercase tracking-widest">Aucun wallet</p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default WalletCard;
