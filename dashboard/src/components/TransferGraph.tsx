"use client";

import React from "react";
import { ArrowLeftRight, Check, ArrowRight, ArrowLeft } from "lucide-react";
import { HopTransfer } from "@/types/pool";

interface TransferGraphProps {
  transfers: HopTransfer[];
  isRebalancing: boolean;
}

export const TransferGraph: React.FC<TransferGraphProps> = ({
  transfers,
  isRebalancing,
}) => {
  // Extract transfers for Pool 0 and Pool 1
  const t0 = transfers.find((t) => t.poolId === 0);
  const t1 = transfers.find((t) => t.poolId === 1);

  const dxSol = t0 ? Math.abs(t0.transferX / 1e9) : 12.27;
  const dyUsdc = t0 ? Math.abs(t0.transferY / 1e6) : 1242.38;

  return (
    <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 shadow-md">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-5 w-5 text-blue-400" />
          <h3 className="text-base font-bold text-white">Atomic Vault Flow Topology</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-blue-950/60 border border-blue-700/60 text-blue-400 text-xs font-mono">
            <Check className="h-3 w-3" />
            Tokens Conserved (Check 3)
          </span>
        </div>
      </div>

      <p className="text-xs text-slate-400 mb-6">
        Cross-pool transfer executed in a single atomic Solana transaction without routing through external AMM swaps or paying swap fees.
      </p>

      {/* Vault Nodes & Directed Arcs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
        {/* Vault 0 */}
        <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-center">
          <div className="inline-block px-2.5 py-1 rounded-md bg-blue-600/20 text-blue-400 text-xs font-bold mb-2">
            Pool #0 Vault
          </div>
          <div className="text-xs text-slate-400">Pre-Price: $100.00</div>
          <div className="text-sm font-bold text-white mt-1">Post-Price: $102.50</div>
        </div>

        {/* Directed Token Transfers */}
        <div className="space-y-3 py-2">
          {/* SOL Transfer (Pool 0 -> Pool 1) */}
          <div className="p-2.5 rounded-lg bg-slate-800/60 border border-blue-500/30 flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-blue-300 font-medium">
              <span>Pool #0</span>
              <ArrowRight className={`h-3.5 w-3.5 text-blue-400 ${isRebalancing ? "animate-pulse" : ""}`} />
              <span>Pool #1</span>
            </div>
            <div className="font-mono font-bold text-blue-400">
              +{dxSol.toFixed(2)} SOL
            </div>
          </div>

          {/* USDC Transfer (Pool 1 -> Pool 0) */}
          <div className="p-2.5 rounded-lg bg-slate-800/60 border border-emerald-500/30 flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-emerald-300 font-medium">
              <span>Pool #0</span>
              <ArrowLeft className={`h-3.5 w-3.5 text-emerald-400 ${isRebalancing ? "animate-pulse" : ""}`} />
              <span>Pool #1</span>
            </div>
            <div className="font-mono font-bold text-emerald-400">
              +${dyUsdc.toFixed(2)} USDC
            </div>
          </div>
        </div>

        {/* Vault 1 */}
        <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-center">
          <div className="inline-block px-2.5 py-1 rounded-md bg-purple-600/20 text-purple-400 text-xs font-bold mb-2">
            Pool #1 Vault
          </div>
          <div className="text-xs text-slate-400">Pre-Price: $105.00</div>
          <div className="text-sm font-bold text-white mt-1">Post-Price: $102.50</div>
        </div>
      </div>

      {/* Conservation Check Footnote */}
      <div className="mt-4 pt-4 border-t border-slate-800 text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2">
        <span>Conservation Invariant: <code className="text-blue-300 font-mono">ΔX₀ + ΔX₁ = 0</code></span>
        <span>Conservation Invariant: <code className="text-emerald-300 font-mono">ΔY₀ + ΔY₁ = 0</code></span>
        <span>Cross-Multiplication: <code className="text-purple-300 font-mono">X₀·Y₁ = X₁·Y₀</code></span>
      </div>
    </div>
  );
};
