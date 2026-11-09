import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export async function GET() {
  const store = getStore();
  const pools = store.pools;

  // Calculate divergence
  let maxDivergenceBps = 0;
  let counterfactualArbProfitEst = 0;

  if (pools.length >= 2) {
    const p0 = pools[0].spotPrice;
    const p1 = pools[1].spotPrice;
    maxDivergenceBps = Math.round((Math.abs(p0 - p1) / Math.min(p0, p1)) * 10000);

    // If divergence exists, estimate counterfactual profit:
    // Profit approx = 0.5 * (P_high - P_low) * delta_x
    if (maxDivergenceBps > 0) {
      // Vector 4 estimation:
      const pLow = Math.min(p0, p1);
      const pHigh = Math.max(p0, p1);
      const pTarget = (pLow + pHigh) / 2;
      const poolLow = pools.find(p => p.spotPrice === pLow)!;
      // dx to move pool from pLow to pTarget:
      // x_new = sqrt(k / pTarget) = sqrt(100000000 / 102.5) = 987.61
      // dx = 1000 - 987.61 = 12.39 SOL
      const k0 = poolLow.reserveA * poolLow.reserveB;
      const xTarget = Math.sqrt(k0 / pTarget);
      const dx = Math.abs(poolLow.reserveA - xTarget);
      counterfactualArbProfitEst = Number(((pHigh - pLow) * dx * 0.5).toFixed(2));
    }
  }

  return NextResponse.json({
    pools,
    divergenceBps: maxDivergenceBps,
    counterfactualArbProfit: counterfactualArbProfitEst,
    network: store.network,
  });
}
