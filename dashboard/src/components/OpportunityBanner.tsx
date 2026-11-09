"use client";

import React from "react";
import { Zap, AlertTriangle, CheckCircle2, RotateCcw, ArrowRight } from "lucide-react";

interface OpportunityBannerProps {
  divergenceBps: number;
  counterfactualArbProfit: number;
  onTriggerRebalance: () => void;
  onResetDemo: () => void;
  isRebalancing: boolean;
}

export const OpportunityBanner: React.FC<OpportunityBannerProps> = ({
  divergenceBps,
  counterfactualArbProfit,
  onTriggerRebalance,
  onResetDemo,
  isRebalancing,
}) => {
  const hasOpportunity = divergenceBps > 5;

  return (
    <div
      className={`rounded-2xl p-6 border transition-all duration-300 ${
        hasOpportunity
          ? "bg-gradient-to-r from-amber-950/40 via-orange-950/30 to-slate-900 border-amber-600/40 shadow-lg shadow-amber-950/20"
          : "bg-gradient-to-r from-emerald-950/30 via-slate-900 to-slate-900 border-emerald-600/30"
      }`}
    >
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
        {/* Left: Status & Impact */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            {hasOpportunity ? (
              <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 text-xs font-semibold">
                <AlertTriangle className="h-3.5 w-3.5" />
                DIVERGENCE DETECTED
              </span>
            ) : (
              <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-semibold">
                <CheckCircle2 className="h-3.5 w-3.5" />
                POOLS IN HARMONY
              </span>
            )}
            <span className="text-slate-400 text-xs font-mono">
              Spread: <strong className="text-white">{divergenceBps} bps</strong>
            </span>
          </div>

          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            {hasOpportunity ? (
              <>
                <span>Atomic Arbitrage Opportunity:</span>
                <span className="text-amber-400">${counterfactualArbProfit.toFixed(2)} USDC at risk</span>
              </>
            ) : (
              <span className="text-emerald-400">Optimal Liquidity Distribution (0 bps spread)</span>
            )}
          </h2>

          <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
            {hasOpportunity ? (
              <>
                Spot price divergence exists across constant-product pools. Without atomic rebalancing,
                external MEV bots will extract <strong>${counterfactualArbProfit.toFixed(2)}</strong> from LP
                liquidity. Triggering PoolSync executes an atomic multi-pool transfer with <strong>100% LP value retention</strong>.
              </>
            ) : (
              <>
                All participating AMM pools satisfy the cross-multiplication invariant{" "}
                <code className="text-emerald-300 bg-emerald-950/60 px-1 py-0.5 rounded font-mono text-xs">
                  Rx_i · Ry_j = Rx_j · Ry_i
                </code>
                . LP capital efficiency is fully optimized against MEV slippage.
              </>
            )}
          </p>
        </div>

        {/* Right: Actions */}
        <div className="flex flex-wrap items-center gap-3 self-stretch lg:self-auto justify-end">
          {hasOpportunity ? (
            <button
              onClick={onTriggerRebalance}
              disabled={isRebalancing}
              className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-bold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 shadow-xl shadow-blue-600/30 active:scale-[0.98] transition-all disabled:opacity-50 text-sm"
            >
              <Zap className={`h-4 w-4 ${isRebalancing ? "animate-bounce text-amber-300" : "text-amber-400"}`} />
              {isRebalancing ? "Executing Atomic Rebalance..." : "Trigger Atomic Rebalance"}
              <ArrowRight className="h-4 w-4 ml-1" />
            </button>
          ) : (
            <button
              onClick={onResetDemo}
              className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-700 hover:text-white border border-slate-700/60 transition-all text-sm"
            >
              <RotateCcw className="h-4 w-4 text-slate-400" />
              Simulate 500 bps Price Shock
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
