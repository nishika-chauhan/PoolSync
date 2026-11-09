"use client";

import React from "react";
import { Activity, ShieldCheck, Wallet, RefreshCw } from "lucide-react";

interface HeaderProps {
  network: "localnet" | "devnet";
  setNetwork: (net: "localnet" | "devnet") => void;
  onRefresh: () => void;
  isLoading: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  network,
  setNetwork,
  onRefresh,
  isLoading,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50 px-6 py-4">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Activity className="h-6 w-6 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white">PoolSync</h1>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-950 text-blue-400 border border-blue-800/60">
                AMM Invariant Engine
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Atomic Multi-Pool Constant-Product Rebalancing on Solana
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Network Switcher */}
          <div className="flex items-center bg-slate-800/80 p-1 rounded-lg border border-slate-700/60 text-xs">
            <button
              onClick={() => setNetwork("localnet")}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                network === "localnet"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Localnet (8899)
            </button>
            <button
              onClick={() => setNetwork("devnet")}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                network === "devnet"
                  ? "bg-purple-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Devnet
            </button>
          </div>

          {/* Refresh Button */}
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-2 rounded-lg bg-slate-800/80 border border-slate-700/60 text-slate-300 hover:text-white hover:bg-slate-700 transition"
            title="Refresh Pool State"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin text-blue-400" : ""}`} />
          </button>

          {/* Wallet Badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-800/50 text-xs text-emerald-400">
            <Wallet className="h-3.5 w-3.5" />
            <span className="font-mono">7xKX...4ZqA</span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
          </div>

          {/* Invariant Engine Badge */}
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-950/40 border border-indigo-800/50 text-xs text-indigo-300">
            <ShieldCheck className="h-3.5 w-3.5 text-indigo-400" />
            <span>Math Verifier Active</span>
          </div>
        </div>
      </div>
    </header>
  );
};
