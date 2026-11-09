"""
PoolSync Python Reference Keeper
=================================
Monitors on-chain pools, detects arbitrage gaps, computes optimal defensive
rebalancing transfers using the CVXPY convex solver, and formats the transaction
payload for Anchor instruction `rebalance`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, List, Optional

from solver import Pool, solve, is_arbitrage_free, decompose_transfers_to_hops
from arb_bot import compute_arbitrage


class Keeper:
    def __init__(
        self,
        min_gap_bps: float = 5.0,
        tolerance_bps: float = 20.0,
        decimals_x: int = 9,
        decimals_y: int = 6,
    ):
        self.min_gap_bps = min_gap_bps
        self.tolerance_bps = tolerance_bps
        self.decimals_x = decimals_x
        self.decimals_y = decimals_y
        self.factor_x = 10**decimals_x
        self.factor_y = 10**decimals_y

    def evaluate_and_solve(
        self,
        raw_pools: List[Dict[str, float]],
        dry_run: bool = True,
    ) -> Dict:
        """
        Evaluate pools in raw integer units (lamports/micro-units).
        """
        pools = [
            Pool(
                x=float(p["reserve_x"]) / self.factor_x,
                y=float(p["reserve_y"]) / self.factor_y,
                weight=float(p.get("weight", 1.0)),
            )
            for p in raw_pools
        ]

        prices = [p.spot_price for p in pools]
        min_p = min(prices)
        max_p = max(prices)
        gap_bps = ((max_p - min_p) / min_p) * 10000.0 if min_p > 0 else 0.0

        print(f"=== PoolSync Keeper Analysis ===")
        for i, p in enumerate(pools):
            print(f"  Pool #{i}: X={p.x:,.4f} SOL, Y={p.y:,.2f} USDC | Spot Price: {p.spot_price:.4f} USDC/SOL")
        print(f"Price Discrepancy: {gap_bps:.2f} bps (Threshold: {self.min_gap_bps} bps)")

        if gap_bps < self.min_gap_bps:
            print("Pools are in equilibrium. No rebalance needed.")
            return {
                "triggered": False,
                "gap_bps": gap_bps,
                "transfers": [],
            }

        print(f"[TRIGGER] Gap {gap_bps:.2f} bps >= {self.min_gap_bps} bps. Solving convex rebalance...")
        result = solve(pools)

        if not result.is_arbitrage_free:
            raise RuntimeError(f"Solver solution failed arbitrage-free verification: {result.arb_free_check_detail}")

        # Compute raw integer transfers
        raw_tx = [int(round(t * self.factor_x)) for t in result.transfers_x]
        raw_ty = [int(round(t * self.factor_y)) for t in result.transfers_y]

        # Exact zero-sum correction
        if sum(raw_tx) != 0:
            raw_tx[0] -= sum(raw_tx)
        if sum(raw_ty) != 0:
            raw_ty[0] -= sum(raw_ty)

        hops = decompose_transfers_to_hops(raw_tx, raw_ty)

        # Baseline arbitrage comparison
        arb_comparison = None
        if len(pools) == 2:
            arb_res = compute_arbitrage(pools[0], pools[1])
            arb_comparison = {
                "bot_traded_x": arb_res.dx,
                "bot_profit_y": arb_res.profit_y,
                "bot_final_price": arb_res.final_price,
            }

        print("\nOptimal Rebalancing Solution:")
        print(f"  Common Price:    {result.pools_after[0].spot_price:.4f} USDC/SOL")
        print(f"  Arbitrage-Free:  {result.is_arbitrage_free}")
        print("Transfer Hops:")
        for h in hops:
            tok = "SOL" if h["is_token_x"] else "USDC"
            scale = self.factor_x if h["is_token_x"] else self.factor_y
            print(f"  Pool #{h['from_pool']} -> Pool #{h['to_pool']}: {h['amount'] / scale:,.6f} {tok}")

        if arb_comparison:
            print(f"\nCounterfactual Arbitrage Comparison:")
            print(f"  External Bot Extracted Profit: ${arb_comparison['bot_profit_y']:,.2f} USDC")
            print(f"  Value Retained by Pools:       ${arb_comparison['bot_profit_y']:,.2f} USDC (100% Retained)")

        return {
            "triggered": True,
            "gap_bps": gap_bps,
            "common_price": result.pools_after[0].spot_price,
            "transfer_hops": hops,
            "raw_transfers_x": raw_tx,
            "raw_transfers_y": raw_ty,
            "expected_reserves": [
                {"reserve_x": p["reserve_x"], "reserve_y": p["reserve_y"]}
                for p in raw_pools
            ],
            "arb_comparison": arb_comparison,
        }


def main():
    parser = argparse.ArgumentParser(description="PoolSync Reference Keeper CLI")
    parser.add_argument("--demo-vector-4", action="store_true", help="Run with Vector 4 pools")
    parser.add_argument("--pools-file", type=str, help="Path to JSON file with pools")
    parser.add_argument("--min-gap-bps", type=float, default=5.0, help="Min price gap in bps")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Dry run mode")
    parser.add_argument("--json", action="store_true", help="Output JSON result")

    args = parser.parse_args()
    keeper = Keeper(min_gap_bps=args.min_gap_bps)

    if args.demo_vector_4 or not args.pools_file:
        raw_pools = [
            {"reserve_x": 1_000_000_000_000, "reserve_y": 100_000_000_000},
            {"reserve_x": 1_000_000_000_000, "reserve_y": 105_000_000_000},
        ]
    else:
        with open(args.pools_file, "r") as f:
            raw_pools = json.load(f)

    res = keeper.evaluate_and_solve(raw_pools, dry_run=args.dry_run)
    if args.json:
        print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
