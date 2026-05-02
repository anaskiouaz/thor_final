import React from 'react';
import { motion } from 'framer-motion';
import { BarChart3, Target, TrendingUp, TrendingDown, Activity } from 'lucide-react';

const StatCard = ({ icon: Icon, label, value, sub, color = 'text-indigo-400', glowColor = 'glow-indigo' }) => (
  <motion.div 
    whileHover={{ y: -5 }}
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    className={`stat-card relative group ${glowColor} border-white/[0.03] overflow-hidden`}
  >
    <div className="absolute -right-4 -top-4 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity">
      <Icon size={100} />
    </div>
    <div className="flex items-center gap-2 mb-3">
      <div className={`p-2 rounded-lg bg-white/[0.03] border border-white/[0.05] ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">{label}</span>
    </div>
    <p className="text-3xl font-black text-white tracking-tight">{value}</p>
    {sub && <p className="text-xs text-slate-500 mt-2 font-medium flex items-center gap-1.5">{sub}</p>}
  </motion.div>
);

const StatsHeader = ({ stats, wallets }) => {
  const totalPnl = stats?.totalPnlUsd ?? 0;
  const winRate = stats?.winRate ?? '0.0';
  const openCount = stats?.openTrades ?? 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
      <StatCard
        icon={BarChart3} label="Volume Analysé" color="text-indigo-400"
        value={stats?.totalTrades ?? 0}
        sub={`${stats?.closedTrades ?? 0} exécutions complétées`}
        glowColor="glow-indigo"
      />
      <StatCard
        icon={Target} label="Précision Winrate" color="text-emerald-400"
        value={`${winRate}%`}
        sub={<><span className="text-emerald-400 font-bold">{stats?.wins ?? 0} Hits</span> sur {stats?.closedTrades ?? 0} trades</>}
        glowColor="glow-emerald"
      />
      <StatCard
        icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
        label="Profit Net" color={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
        value={totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`}
        sub={`${(stats?.totalSolSpent ?? 0).toFixed(2)} SOL de liquidité utilisée`}
        glowColor={totalPnl >= 0 ? 'glow-emerald' : 'glow-red'}
      />
      <StatCard
        icon={Activity} label="Monitoring Actif" color="text-amber-400"
        value={openCount}
        sub={<><span className="text-amber-400 font-bold">{wallets?.length ?? 0} Target Wallets</span> en temps réel</>}
        glowColor="glow-amber"
      />
    </div>
  );
};

export default StatsHeader;
