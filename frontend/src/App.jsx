import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plus, Trash2, Bell, Shield, Wallet, Activity } from 'lucide-react';

const API_BASE = 'http://' + window.location.hostname + ':3000/api';

function App() {
  const [wallets, setWallets] = useState([]);
  const [detections, setDetections] = useState([]);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [walletDetail, setWalletDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const [wRes, dRes] = await Promise.all([
        axios.get(`${API_BASE}/wallets`),
        axios.get(`${API_BASE}/detections`)
      ]);
      setWallets(wRes.data);
      setDetections(dRes.data);
    } catch (err) {
      console.error('Error fetching data:', err);
    }
  };

  const fetchWalletDetail = async (address) => {
    setSelectedWallet(address);
    setDetailLoading(true);
    setWalletDetail(null);
    try {
      const res = await axios.get(`${API_BASE}/wallets/${address}/detail`);
      setWalletDetail(res.data);
    } catch (err) {
      alert('Error fetching wallet details: ' + (err.response?.data?.error || err.message));
    } finally {
      setDetailLoading(false);
    }
  };

  const addWallet = async (e) => {
    e.preventDefault();
    if (!address) return;
    setLoading(true);
    try {
      await axios.post(`${API_BASE}/wallets`, { address, label });
      setAddress('');
      setLabel('');
      fetchData();
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      alert('Error adding wallet: ' + msg);
    } finally {
      setLoading(false);
    }
  };

  const removeWallet = async (id) => {
    if (!confirm('Are you sure you want to stop watching this wallet?')) return;
    try {
      await axios.delete(`${API_BASE}/wallets/${id}`);
      fetchData();
    } catch (err) {
      alert('Error removing wallet: ' + err.message);
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8">
      <header className="max-w-6xl mx-auto mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Wallet Token Tracker</h1>
            <p className="text-slate-400 text-sm">Monitoring contract deployments in real-time</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-2 bg-slate-800/50 px-4 py-2 rounded-full border border-slate-700">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span className="text-sm font-medium">Monitoring Active</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Wallet Management */}
        <div className="lg:col-span-1 space-y-6">
          <section className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Plus className="w-5 h-5 text-blue-400" />
              Add Wallet to Watch
            </h2>
            <form onSubmit={addWallet} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Wallet Address</label>
                <input 
                  type="text" 
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="0x..." 
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Label (Optional)</label>
                <input 
                  type="text" 
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Whale #1" 
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                />
              </div>
              <button 
                type="submit" 
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {loading ? 'Adding...' : 'Start Watching'}
              </button>
            </form>
          </section>

          <section className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Wallet className="w-5 h-5 text-purple-400" />
              Watched Wallets ({wallets.length})
            </h2>
            <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {wallets.length === 0 && <p className="text-slate-500 text-sm italic text-center py-4">No wallets added yet.</p>}
              {wallets.map(w => (
                <div 
                  key={w.id} 
                  onClick={() => fetchWalletDetail(w.address)}
                  className="bg-slate-900 p-3 rounded-xl border border-slate-700 flex items-center justify-between group cursor-pointer hover:border-blue-500/50 transition-all"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-200 truncate">{w.label || 'Unnamed Wallet'}</p>
                    <p className="text-xs text-slate-500 font-mono truncate">{w.address}</p>
                  </div>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      removeWallet(w.id);
                    }}
                    className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Right Column: Alerts */}
        <div className="lg:col-span-2">
          <section className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm h-full flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Bell className="w-5 h-5 text-yellow-400" />
                Live Detections
              </h2>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
                <Activity className="w-3 h-3" />
                Updating Live
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto pr-2 custom-scrollbar">
              {detections.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                  <Activity className="w-12 h-12 mb-4 opacity-20" />
                  <p>No token deployments detected yet.</p>
                  <p className="text-sm">Wait for a watched wallet to deploy a contract.</p>
                </div>
              )}
              
              {detections.map(d => (
                <div key={d.id} className="bg-slate-900 p-4 rounded-xl border-l-4 border-l-blue-500 border border-slate-700 hover:border-blue-500/50 transition-all">
                  <div className="flex flex-wrap justify-between items-start gap-4">
                    <div>
                      <span className="inline-block bg-blue-500/10 text-blue-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase mb-2">New Token Deployment</span>
                      <h3 className="font-bold text-lg text-white mb-1">Contract Created</h3>
                      <div className="text-sm space-y-1">
                        <p className="text-slate-400 flex items-center gap-2">
                          <span className="font-semibold">Deployer:</span> 
                          <span className="font-mono text-xs">{d.wallet_address}</span>
                        </p>
                        <p className="text-slate-400 flex items-center gap-2">
                          <span className="font-semibold">Token:</span> 
                          <span className="text-green-400 font-mono text-xs">{d.token_address}</span>
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-500 mb-2">{new Date(d.timestamp).toLocaleString()}</p>
                      <a 
                        href={`https://solscan.io/tx/${d.tx_hash}`} 
                        target="_blank" 
                        rel="noreferrer"
                        className="inline-block text-xs font-semibold text-blue-400 hover:text-blue-300 underline underline-offset-4"
                      >
                        View on Explorer
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>

      {/* Wallet Detail Modal */}
      {selectedWallet && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-slate-700 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">Wallet Details</h2>
                <p className="text-slate-400 font-mono text-xs">{selectedWallet}</p>
              </div>
              <button 
                onClick={() => setSelectedWallet(null)}
                className="text-slate-400 hover:text-white p-2"
              >
                ✕
              </button>
            </div>
            
            <div className="p-6">
              {detailLoading ? (
                <div className="py-12 flex flex-col items-center gap-4">
                  <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-slate-400">Fetching Solscan data...</p>
                </div>
              ) : walletDetail ? (
                <div className="space-y-6">
                    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-700 flex items-center justify-between">
                      <div>
                        <p className="text-slate-400 text-sm mb-1">{walletDetail.chain === 'solana' ? 'SOL Balance' : 'ETH Balance'}</p>
                        <p className="text-4xl font-bold text-white">
                          {walletDetail.balance.toFixed(4)} 
                          <span className="text-blue-400 text-lg ml-2">{walletDetail.chain === 'solana' ? 'SOL' : 'ETH'}</span>
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className={`px-3 py-1 rounded-full text-xs font-bold ${walletDetail.chain === 'solana' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          {walletDetail.chain.toUpperCase()}
                        </div>
                        <div className="bg-blue-500/10 p-3 rounded-2xl">
                          <Wallet className="w-6 h-6 text-blue-400" />
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Plus className="w-5 h-5 text-green-400" />
                        {walletDetail.chain === 'solana' ? 'Top Tokens Held' : 'Recent Tokens'}
                      </h3>
                      <div className="space-y-3">
                        {walletDetail.createdTokens.length === 0 ? (
                          <p className="text-slate-500 italic text-sm">No token holdings or recent creations found.</p>
                        ) : (
                          walletDetail.createdTokens.map((token, idx) => (
                            <div key={idx} className="bg-slate-900/50 p-4 rounded-xl border border-slate-700 flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="bg-blue-600/20 text-blue-400 text-[10px] font-bold px-1.5 py-0.5 rounded">
                                    {token.symbol || '???'}
                                  </span>
                                  <p className="text-white font-semibold text-sm">{token.name || 'Token'}</p>
                                </div>
                                <p className="text-xs text-slate-500 font-mono mt-1">
                                  {token.mint.slice(0, 8)}...{token.mint.slice(-8)}
                                </p>
                                {token.amount !== undefined && (
                                  <p className="text-xs text-green-400 font-medium mt-0.5">Balance: {token.amount.toLocaleString()}</p>
                                )}
                              </div>
                              <a 
                                href={`${walletDetail.explorerBase}/token/${token.mint}`} 
                                target="_blank" 
                                rel="noreferrer"
                                className="text-blue-400 hover:text-blue-300 text-xs font-semibold bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700 transition-all"
                              >
                                Details
                              </a>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                </div>
              ) : (
                <p className="text-center py-12 text-slate-500">Failed to load data.</p>
              )}
            </div>
            
            <div className="p-6 bg-slate-900/50 border-t border-slate-700 flex justify-end">
              <button 
                onClick={() => setSelectedWallet(null)}
                className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="max-w-6xl mx-auto mt-12 pt-8 border-t border-slate-800 text-center text-slate-500 text-sm">
        <p>&copy; 2026 Wallet Token Tracker. Built for Tailscale access.</p>
      </footer>
    </div>
  );
}

export default App;
