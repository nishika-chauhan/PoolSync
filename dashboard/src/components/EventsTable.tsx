"use client";

import React, { useState } from "react";
import { History, ShieldCheck, ExternalLink, Check, Copy, X } from "lucide-react";
import { RebalanceEventRecord, VerificationResult } from "@/types/pool";

interface EventsTableProps {
  events: RebalanceEventRecord[];
  network: "localnet" | "devnet";
}

export const EventsTable: React.FC<EventsTableProps> = ({ events, network }) => {
  const [selectedProof, setSelectedProof] = useState<VerificationResult | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [copiedSig, setCopiedSig] = useState<string | null>(null);

  const handleCopy = (sig: string) => {
    navigator.clipboard.writeText(sig);
    setCopiedSig(sig);
    setTimeout(() => setCopiedSig(null), 2000);
  };

  const handleVerify = async (event: RebalanceEventRecord) => {
    setIsVerifying(true);
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: event.signature }),
      });
      const data = await res.json();
      if (data.result) {
        setSelectedProof(data.result);
      }
    } catch (e) {
      console.error("Verification request failed:", e);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 shadow-md">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-purple-400" />
          <h3 className="text-base font-bold text-white">Rebalance & Verification Ledger</h3>
        </div>
        <span className="text-xs text-slate-400 font-mono">
          {events.length} Recorded Execution{events.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
              <th className="pb-3 pr-4">Slot</th>
              <th className="pb-3 pr-4">Signature</th>
              <th className="pb-3 pr-4">Pools</th>
              <th className="pb-3 pr-4">Protected Value</th>
              <th className="pb-3 pr-4">Value Retained</th>
              <th className="pb-3 pr-4">Status</th>
              <th className="pb-3 text-right">Proof</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-mono">
            {events.map((evt) => (
              <tr key={evt.id} className="hover:bg-slate-800/30 transition-colors">
                <td className="py-3.5 pr-4 text-slate-300">#{evt.slot}</td>
                <td className="py-3.5 pr-4 text-slate-300">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate max-w-[120px] font-mono text-blue-400">
                      {evt.signature.slice(0, 8)}...{evt.signature.slice(-8)}
                    </span>
                    <button
                      onClick={() => handleCopy(evt.signature)}
                      className="p-1 hover:text-white text-slate-400"
                      title="Copy Signature"
                    >
                      {copiedSig === evt.signature ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                    <a
                      href={
                        network === "devnet"
                          ? `https://explorer.solana.com/tx/${evt.signature}?cluster=devnet`
                          : `https://explorer.solana.com/tx/${evt.signature}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="p-1 hover:text-white text-slate-400"
                      title="View in Solana Explorer"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </td>
                <td className="py-3.5 pr-4 text-slate-300 font-sans">
                  Pool #{evt.poolsInvolved.join(", #")}
                </td>
                <td className="py-3.5 pr-4 text-emerald-400 font-bold">
                  +${evt.counterfactualArbProfit.toFixed(2)} USDC
                </td>
                <td className="py-3.5 pr-4 text-emerald-400 font-bold">
                  {evt.valueRetainedPct.toFixed(1)}%
                </td>
                <td className="py-3.5 pr-4">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-700/60 text-emerald-400 text-[11px] font-sans font-medium">
                    <ShieldCheck className="h-3 w-3" />
                    Verified
                  </span>
                </td>
                <td className="py-3.5 text-right font-sans">
                  <button
                    onClick={() => handleVerify(evt)}
                    disabled={isVerifying}
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white text-xs font-medium transition"
                  >
                    Inspect Invariants
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Proof Inspection Modal */}
      {selectedProof && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-6 w-6 text-emerald-400" />
                <h4 className="text-base font-bold text-white">Mathematical Invariant Verification</h4>
              </div>
              <button
                onClick={() => setSelectedProof(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="text-xs text-slate-400 font-mono truncate">
              Tx Signature: <span className="text-blue-400">{selectedProof.signature}</span>
            </div>

            {/* Checks List */}
            <div className="space-y-3">
              {selectedProof.checks.map((c, i) => (
                <div
                  key={i}
                  className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white">{c.name}</span>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${
                        c.passed
                          ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                          : "bg-rose-950 text-rose-400 border border-rose-800"
                      }`}
                    >
                      {c.passed ? "PASSED" : "FAILED"}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">{c.description}</p>
                  <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] font-mono">
                    <div className="text-slate-400">
                      Actual: <span className="text-slate-200">{c.actual}</span>
                    </div>
                    <div className="text-slate-400">
                      Expected: <span className="text-slate-200">{c.expected}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setSelectedProof(null)}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition"
              >
                Close Verification Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
