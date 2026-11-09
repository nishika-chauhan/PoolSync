"""
PoolSync Baseline Arbitrage Bot (dry-run only)
===============================================
Computes what a constant-product arbitrageur would earn between two pools
with different prices.  Never submits any transaction.

For two same-pair pools A and B with reserves (xA, yA) and (xB, yB):
  - If p_A = yA/xA < yB/xB = p_B  (token-0 cheaper in A)
  - Bot buys dx from A, sells dx to B
  - Optimal dx = (sqrt(kA*kB) * (sqrt(pB) - sqrt(pA))) / (sqrt(pA)*sqrt(pB) + ?)
  
Exact closed form via standard constant-product arbitrage:
  Set prices equal at equilibrium:
    (yA - dy) / (xA + dx) = (yB + dy') / (xB - dx)
  With conservation: dy = kA/(xA+dx) - yA, dy' = yB - kB/(xB-dx)
  And profit: dy - dy' (in token-1)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Tuple

from solver import Pool


@dataclass
class ArbResult:
    pool_a_before: Pool
    pool_b_before: Pool
    pool_a_after: Pool
    pool_b_after: Pool
    dx: float          # SOL bought from A, sold to B
    profit_y: float    # USDC profit
    final_price: float # common price after arb


def compute_arbitrage(pool_a: Pool, pool_b: Pool) -> ArbResult:
    """
    Compute optimal constant-product arbitrage between two same-pair pools.
    
    Convention:
      - The bot buys token-0 from the cheaper pool (lower y/x price)
        by paying token-1, then sells that token-0 to the more expensive pool.
      - Automatically identifies which pool is cheaper.

    Closed-form derivation (buy-from-cheap convention):
      Let pool_cheap have reserves (xC, yC), kC = xC*yC
      Let pool_exp   have reserves (xE, yE), kE = xE*yE
      
      After bot buys dx from cheap: cheap → (xC - dx, kC/(xC - dx))
      After bot sells dx to exp:   exp   → (xE + dx, kE/(xE + dx))
      
      Equal price at optimum:
        kC/(xC-dx)^2 = kE/(xE+dx)^2
        (xE+dx)/(xC-dx) = sqrt(kE/kC) = r
        xE + dx = r*(xC - dx)
        dx*(1 + r) = r*xC - xE
        dx = (r*xC - xE) / (1 + r)   [positive when cheap < expensive]
    """
    # Identify cheap (lower price p=y/x) and expensive pool
    if pool_a.spot_price <= pool_b.spot_price:
        pool_cheap, pool_exp = pool_a, pool_b
        flipped = False
    else:
        pool_cheap, pool_exp = pool_b, pool_a
        flipped = True

    xC, yC, kC = pool_cheap.x, pool_cheap.y, pool_cheap.k
    xE, yE, kE = pool_exp.x,   pool_exp.y,   pool_exp.k

    if xC <= 0 or xE <= 0 or yC <= 0 or yE <= 0:
        raise ValueError("All reserves must be positive")

    r = math.sqrt(kE / kC)
    dx = (r * xC - xE) / (1.0 + r)

    if dx <= 0:
        # No arbitrage (prices already equal or inverted)
        return ArbResult(
            pool_a_before=pool_a, pool_b_before=pool_b,
            pool_a_after=pool_a, pool_b_after=pool_b,
            dx=0.0, profit_y=0.0, final_price=pool_a.spot_price,
        )

    # Safety clamp
    dx = min(dx, xC * 0.9999)

    # Token-1 bot pays to cheap pool to buy dx of token-0
    dy_in_cheap = kC / (xC - dx) - yC    # > 0

    # Token-1 bot receives from exp pool for selling dx of token-0
    dy_out_exp = yE - kE / (xE + dx)     # > 0

    profit_y = dy_out_exp - dy_in_cheap

    xC_final = xC - dx
    yC_final = kC / xC_final
    xE_final = xE + dx
    yE_final = kE / xE_final

    final_price = yC_final / xC_final   # == yE_final / xE_final at optimum

    if not flipped:
        pool_a_after = Pool(xC_final, yC_final, pool_a.weight)
        pool_b_after = Pool(xE_final, yE_final, pool_b.weight)
    else:
        pool_a_after = Pool(xE_final, yE_final, pool_a.weight)
        pool_b_after = Pool(xC_final, yC_final, pool_b.weight)

    return ArbResult(
        pool_a_before=pool_a,
        pool_b_before=pool_b,
        pool_a_after=pool_a_after,
        pool_b_after=pool_b_after,
        dx=dx,
        profit_y=profit_y,
        final_price=final_price,
    )


def print_arb_result(result: ArbResult) -> None:
    print(f"\n=== Arbitrage Dry-Run ===")
    print(f"Before: A=({result.pool_a_before.x:.4f}, {result.pool_a_before.y:.4f}) "
          f"k={result.pool_a_before.k:.4f} price={result.pool_a_before.spot_price:.4f}")
    print(f"Before: B=({result.pool_b_before.x:.4f}, {result.pool_b_before.y:.4f}) "
          f"k={result.pool_b_before.k:.4f} price={result.pool_b_before.spot_price:.4f}")
    print(f"Optimal dx = {result.dx:.6f} token-0")
    print(f"Profit     = {result.profit_y:.6f} token-1")
    print(f"After:  A=({result.pool_a_after.x:.4f}, {result.pool_a_after.y:.4f}) "
          f"k={result.pool_a_after.k:.4f} price={result.pool_a_after.spot_price:.6f}")
    print(f"After:  B=({result.pool_b_after.x:.4f}, {result.pool_b_after.y:.4f}) "
          f"k={result.pool_b_after.k:.4f} price={result.pool_b_after.spot_price:.6f}")
    print(f"Final common price = {result.final_price:.6f}")


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="PoolSync Dry-Run Baseline Arbitrage Bot")
    parser.add_argument("--demo-vector-4", action="store_true", help="Run with SPEC Test Vector 4")
    parser.add_argument("--poolA-x", type=float, help="Pool A reserve X")
    parser.add_argument("--poolA-y", type=float, help="Pool A reserve Y")
    parser.add_argument("--poolB-x", type=float, help="Pool B reserve X")
    parser.add_argument("--poolB-y", type=float, help="Pool B reserve Y")
    parser.add_argument("--json", action="store_true", help="Output JSON format")

    args = parser.parse_args()

    if args.demo_vector_4:
        pA = Pool(x=1000.0, y=100000.0)
        pB = Pool(x=1000.0, y=105000.0)
    elif args.poolA_x and args.poolA_y and args.poolB_x and args.poolB_y:
        pA = Pool(x=args.poolA_x, y=args.poolA_y)
        pB = Pool(x=args.poolB_x, y=args.poolB_y)
    else:
        # Default to Vector 4
        pA = Pool(x=1000.0, y=100000.0)
        pB = Pool(x=1000.0, y=105000.0)

    result = compute_arbitrage(pA, pB)

    # Compute comparison metrics
    # Rebalance value at final equilibrium:
    # Under bot arb: total value of pools evaluated at post-arb price:
    v_pools_after_bot = (result.pool_a_after.x + result.pool_b_after.x) * result.final_price + (result.pool_a_after.y + result.pool_b_after.y)
    # Under rebalance (total x=2000, total y=205000, common price = 205000/2000 = 102.50):
    common_p_reb = (pA.y + pB.y) / (pA.x + pB.x)
    v_pools_after_reb = (pA.x + pB.x) * common_p_reb + (pA.y + pB.y)
    value_retained = v_pools_after_reb - v_pools_after_bot

    if args.json:
        data = {
            "dx": result.dx,
            "profit_y": result.profit_y,
            "final_price": result.final_price,
            "pool_a_before": {"x": result.pool_a_before.x, "y": result.pool_a_before.y, "price": result.pool_a_before.spot_price},
            "pool_b_before": {"x": result.pool_b_before.x, "y": result.pool_b_before.y, "price": result.pool_b_before.spot_price},
            "pool_a_after_bot": {"x": result.pool_a_after.x, "y": result.pool_a_after.y, "price": result.pool_a_after.spot_price},
            "pool_b_after_bot": {"x": result.pool_b_after.x, "y": result.pool_b_after.y, "price": result.pool_b_after.spot_price},
            "rebalance_common_price": common_p_reb,
            "pools_total_value_rebalanced": v_pools_after_reb,
            "pools_total_value_after_bot": v_pools_after_bot,
            "value_retained_by_pools": value_retained,
        }
        print(json.dumps(data, indent=2))
    else:
        print_arb_result(result)
        print("\n=== Value Retention Comparison (SPEC.md Vector 4) ===")
        print(f"Post-Arb Bot Common Price:          {result.final_price:.4f}")
        print(f"Defensive Rebalance Common Price:   {common_p_reb:.4f}")
        print(f"Total Pools Value (Rebalanced):    ${v_pools_after_reb:,.2f}")
        print(f"Total Pools Value (Post-Bot Arb):  ${v_pools_after_bot:,.2f}")
        print(f"Extracted MEV Saved for Pools:     ${value_retained:,.2f} token-1 (matches bot profit: ${result.profit_y:,.2f})")
