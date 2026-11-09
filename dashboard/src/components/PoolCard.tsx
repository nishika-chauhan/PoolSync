"use client";

import React from "react";
import { Layers, Shield, ArrowUpRight, Percent } from "lucide-react";
import { PoolData } from "@/types/pool";

interface PoolCardProps {
  pool: PoolData;
  targetPrice?: number;
}

export const PoolCard: React.FC<PoolCardProps> = ({ pool, targetPrice }) => {
  const divergenceFromTarget = targetPrice
    ? Math.abs((pool.spotPrice - targetPrice) / targetPrice) * 10000
    : 0;

  return (
    <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 flex flex-col justify-between hover:border-slate-700 transition-all duration-200 shadow-md">
      <div>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-sm border border-blue-500/20">
              #{pool.id}
            </div>
            <div>
              <div className="text-sm font-bold text-white flex items-center gap-1.5">
                SOL / USDC
                <span className="text-[10px] text-slate-400 font-normal">Constant-Product</span>
              </div>
              <div className="text-[11px] font-mono text-slate-400 truncate max-w-[140px]">
                {pool.pubkey}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {pool.optedIn ? (
              <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-700/60 text-emerald-400 text-[11px] font-medium">
                <Shield className="h-3 w-3" />
                Opted In
              </span>
            ) : (
              <span className="px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[11px]">
                Isolated
              </span>
            )}
          </div>
        </div>

        {/* Spot Price Display */}
        <div className="my-5 p-4 rounded-xl bg-slate-950/80 border border-slate-800/80">
          <div className="text-xs text-slate-400 uppercase tracking-wider font-semibold mb-1 flex items-center justify-between">
            <span>Spot Price</span>
            {divergenceFromTarget > 1 && (
              <span className="text-amber-400 text-[11px] font-mono">
                +{divergenceFromTarget.toFixed(0)} bps spread
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">
              ${pool.spotPrice.toFixed(4)}
            </span>
            <span className="text-xs text-slate-400 font-medium">USDC / SOL</span>
          </div>
        </div>

        {/* Reserves Breakdown */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <div className="text-[11px] text-slate-400 mb-0.5 font-medium">Reserve X (SOL)</div>
            <div className="text-sm font-bold text-slate-200 font-mono">
              {pool.reserveA.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <div className="text-[11px] text-slate-400 mb-0.5 font-medium">Reserve Y (USDC)</div>
            <div className="text-sm font-bold text-slate-200 font-mono">
              ${pool.reserveB.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {/* Invariant k */}
        <div className="flex items-center justify-between text-xs text-slate-400 py-2 border-t border-slate-800/80">
          <span className="flex items-center gap-1">
            <Layers className="h-3.5 w-3.5 text-blue-400" />
            Invariant (k = x·y)
          </span>
          <span className="font-mono text-slate-300 font-medium">
            {(pool.reserveA * pool.reserveB).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </div>
      </div>

      {/* Footer / Policy */}
      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
        <span className="flex items-center gap-1">
          <Percent className="h-3 w-3 text-slate-400" />
          Fee: {pool.feeBps} bps
        </span>
        <span className="font-mono text-slate-400">
          Cap: {pool.policy.maxSingleRebalanceBps} bps
        </span>
      </div>
    </div>
  );
};
