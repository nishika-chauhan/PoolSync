"use client";

import React, { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { OpportunityBanner } from "@/components/OpportunityBanner";
import { PoolCard } from "@/components/PoolCard";
import { TransferGraph } from "@/components/TransferGraph";
import { ValueRetentionPanel } from "@/components/ValueRetentionPanel";
import { EventsTable } from "@/components/EventsTable";
import { PoolData, RebalanceEventRecord, HopTransfer } from "@/types/pool";

export default function Home() {
  const [network, setNetwork] = useState<"localnet" | "devnet">("localnet");
  const [pools, setPools] = useState<PoolData[]>([]);
  const [events, setEvents] = useState<RebalanceEventRecord[]>([]);
  const [divergenceBps, setDivergenceBps] = useState<number>(500);
  const [counterfactualArbProfit, setCounterfactualArbProfit] = useState<number>(30.49);
  const [isRebalancing, setIsRebalancing] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [recentTransfers, setRecentTransfers] = useState<HopTransfer[]>([
    { poolId: 0, transferX: -12195121951, transferY: 1248456000 },
    { poolId: 1, transferX: 12195121951, transferY: -1248456000 },
  ]);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [poolsRes, eventsRes] = await Promise.all([
        fetch("/api/pools"),
        fetch("/api/events"),
      ]);
      const poolsData = await poolsRes.json();
      const eventsData = await eventsRes.json();

      if (poolsData.pools) {
        setPools(poolsData.pools);
        setDivergenceBps(poolsData.divergenceBps ?? 0);
        setCounterfactualArbProfit(poolsData.counterfactualArbProfit ?? 0);
      }
      if (eventsData.events) {
        setEvents(eventsData.events);
      }
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleTriggerRebalance = async () => {
    setIsRebalancing(true);
    try {
      const res = await fetch("/api/rebalance", {
        method: "POST",
      });
      const data = await res.json();
      if (data.rebalanced && data.summary) {
        setRecentTransfers(data.summary.transfers);
      }
      await fetchData();
    } catch (err) {
      console.error("Failed to execute rebalance:", err);
    } finally {
      setIsRebalancing(false);
    }
  };

  const handleResetDemo = async () => {
    // Reset pool 0 to 100 USDC and pool 1 to 105 USDC (500 bps shock)
    setPools((prev) => [
      {
        ...prev[0],
        reserveA: 1000.0,
        reserveB: 100000.0,
        spotPrice: 100.0,
      },
      {
        ...prev[1],
        reserveA: 1000.0,
        reserveB: 105000.0,
        spotPrice: 105.0,
      },
    ]);
    setDivergenceBps(500);
    setCounterfactualArbProfit(30.49);
  };

  const targetEquilibriumPrice =
    pools.length >= 2
      ? (pools[0].reserveB + pools[1].reserveB) / (pools[0].reserveA + pools[1].reserveA)
      : undefined;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Header
        network={network}
        setNetwork={setNetwork}
        onRefresh={fetchData}
        isLoading={isLoading}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 space-y-8">
        {/* Opportunity & Trigger Banner */}
        <OpportunityBanner
          divergenceBps={divergenceBps}
          counterfactualArbProfit={counterfactualArbProfit}
          onTriggerRebalance={handleTriggerRebalance}
          onResetDemo={handleResetDemo}
          isRebalancing={isRebalancing}
        />

        {/* Section: AMM Pool Reserves & Spot Prices */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">Constant-Product Pool Pair Topology</h2>
              <p className="text-xs text-slate-400">
                Monitored on-chain AMM pools sharing the same token pair (SOL/USDC)
              </p>
            </div>
            {targetEquilibriumPrice && (
              <div className="text-xs bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg text-slate-300">
                Equilibrium Price Target:{" "}
                <span className="font-mono font-bold text-white">
                  ${targetEquilibriumPrice.toFixed(4)}
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {pools.map((p) => (
              <PoolCard
                key={p.id}
                pool={p}
                targetPrice={targetEquilibriumPrice}
              />
            ))}
          </div>
        </div>

        {/* Section: Atomic Transfer Graph & Value Retention Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TransferGraph
            transfers={recentTransfers}
            isRebalancing={isRebalancing}
          />
          <ValueRetentionPanel
            counterfactualArbProfit={counterfactualArbProfit}
          />
        </div>

        {/* Section: Verification Ledger & Historical Rebalance Events */}
        <EventsTable
          events={events}
          network={network}
        />
      </main>

      <footer className="border-t border-slate-900 bg-slate-950 py-6 px-6 text-center text-xs text-slate-400">
        <p>
          PoolSync: Constant-Product AMM with Atomic Multi-Pool Rebalancing. Devnet & Localnet Research Prototype. Not Audited for Production.
        </p>
      </footer>
    </div>
  );
}
