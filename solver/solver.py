"""
PoolSync Reference Solver
=========================
Implements the convex optimizer from:
  Devorsetz & Herlihy, "Defensive Rebalancing in Networks of Automated
  Market Makers", AFT 2026, LIPIcs vol. 395, article 12,
  DOI 10.4230/LIPIcs.AFT.2026.12

Maximize  sum_i [ w_i * (log x_i' + log y_i') ]
Subject to:
  - x_i' * y_i' >= x_i * y_i  (k non-reduction, per pool)
  - sum_i x_i' == sum_i x_i   (token-0 conservation)
  - sum_i y_i' == sum_i y_i   (token-1 conservation)
  - x_i', y_i' > 0            (positive reserves)

Architecture:
  1. Reserve scaling: scales token-0 and token-1 dimensions independently
     by scale_x = max(x_i) and scale_y = max(y_i).
  2. CVXPY conic optimization formulation using Clarabel.
  3. KKT projection (water-filling): paper Theorem 12 proves that for
     same-pair pools, the unique Pareto efficient / arbitrage-free
     equilibrium spot price is p* = sum(y_i) / sum(x_i). The water-filling
     step projects the conic solution to the exact algebraic KKT optimum,
     eliminating numerical interior-point solver drift and guaranteeing exact
     token conservation, monotonic k, and 0-error arbitrage-free spot prices.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np
import cvxpy as cp


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class Pool:
    """A constant-product pool state."""
    x: float             # reserve of token-0 (base)
    y: float             # reserve of token-1 (quote)
    weight: float = 1.0  # surplus-sharing weight (default 1.0)

    @property
    def k(self) -> float:
        return self.x * self.y

    @property
    def spot_price(self) -> float:
        """Price of token-0 in units of token-1 (y / x)."""
        return self.y / self.x


@dataclass
class RebalanceResult:
    """Output of the optimizer."""
    pools_before: List[Pool]
    pools_after: List[Pool]
    status: str
    objective_value: Optional[float] = None
    is_arbitrage_free: bool = False
    arb_free_check_detail: str = ""

    @property
    def transfers_x(self) -> List[float]:
        """token-0 transfer for each pool (positive = pool receives)."""
        return [self.pools_after[i].x - self.pools_before[i].x
                for i in range(len(self.pools_before))]

    @property
    def transfers_y(self) -> List[float]:
        """token-1 transfer for each pool (positive = pool receives)."""
        return [self.pools_after[i].y - self.pools_before[i].y
                for i in range(len(self.pools_before))]


# ---------------------------------------------------------------------------
# Arbitrage-free checker
# ---------------------------------------------------------------------------

def is_arbitrage_free(
    pools: List[Pool],
    tolerance_bps: float = 1.0,
) -> Tuple[bool, str]:
    """
    Check arbitrage-free condition for same-pair pools.
    Paper (Theorem 12): a configuration is arbitrage-free iff it is
    Pareto efficient under rebalancing. For same-pair pools, this means
    all spot prices are equal.

    Uses cross-multiplication to avoid division:
        y_i / x_i == y_j / x_j  <=>  y_i * x_j == y_j * x_i

    tolerance_bps: allowed relative deviation in basis points (default 1 bp).
    Returns (is_ok, detail_string).
    """
    if len(pools) <= 1:
        return True, "Single pool is trivially arbitrage-free"

    tol = tolerance_bps / 10_000.0  # convert bps to fraction

    ref = pools[0]
    details = []
    all_ok = True

    for i, p in enumerate(pools[1:], start=1):
        lhs = p.y * ref.x
        rhs = ref.y * p.x
        avg = (lhs + rhs) / 2.0
        rel_dev = abs(lhs - rhs) / avg if avg > 0 else 0.0
        ok = rel_dev <= tol
        details.append(
            f"Pool 0 vs Pool {i}: price0={ref.spot_price:.8f} "
            f"price{i}={p.spot_price:.8f} rel_dev={rel_dev:.2e} ok={ok}"
        )
        if not ok:
            all_ok = False

    return all_ok, "; ".join(details)


# ---------------------------------------------------------------------------
# Exact KKT Water-Filling Projection for Same-Pair Pools
# ---------------------------------------------------------------------------

def solve_water_filling(pools: List[Pool]) -> List[Pool]:
    """
    Computes the exact KKT optimum for same-pair constant-product pools.

    Derivation:
      Let X = sum(x_i), Y = sum(y_i).
      From KKT conditions: y_i' / x_i' = mu_x / mu_y = p* (constant).
      Conservation requires: sum(y_i') = p* sum(x_i') => Y = p* X => p* = Y / X.
      Then k_i' = x_i' * y_i' = p* (x_i')^2 >= k_i => x_i' >= sqrt(k_i / p*).
      The convex problem reduces to:
        Maximize sum_i w_i * log(x_i') subject to sum_i x_i' = X, x_i' >= sqrt(k_i / p*).
      Solved via water-filling with lower bounds in at most n steps.
    """
    X = sum(p.x for p in pools)
    Y = sum(p.y for p in pools)
    p_star = Y / X
    n = len(pools)

    x_min = [math.sqrt(p.k / p_star) for p in pools]
    weights = [p.weight for p in pools]

    remaining_indices = list(range(n))
    x_sol = [0.0] * n
    X_rem = X

    while remaining_indices:
        W_rem = sum(weights[i] for i in remaining_indices)
        tentative = {i: X_rem * (weights[i] / W_rem) for i in remaining_indices}
        violators = [i for i in remaining_indices if tentative[i] < x_min[i]]
        if not violators:
            for i in remaining_indices:
                x_sol[i] = tentative[i]
            break
        # Clamp the most constrained pool to its k-floor
        violators.sort(key=lambda i: x_min[i] / tentative[i], reverse=True)
        to_clamp = violators[0]
        x_sol[to_clamp] = x_min[to_clamp]
        X_rem -= x_min[to_clamp]
        remaining_indices.remove(to_clamp)

    y_sol = [p_star * x for x in x_sol]
    return [Pool(x=x_sol[i], y=y_sol[i], weight=pools[i].weight) for i in range(n)]


# ---------------------------------------------------------------------------
# Solver
# ---------------------------------------------------------------------------

def solve(
    pools: List[Pool],
    scale_x: Optional[float] = None,
    scale_y: Optional[float] = None,
    solver: str = "CLARABEL",
    verbose: bool = False,
    run_conic: bool = True,
) -> RebalanceResult:
    """
    Run the convex rebalance optimizer.

    pools     : list of Pool with current reserves and weights
    scale_x   : reserve scaling factor for token-0 (auto if None)
    scale_y   : reserve scaling factor for token-1 (auto if None)
    solver    : CVXPY solver name (default "CLARABEL")
    verbose   : pass to CVXPY
    run_conic : whether to solve the CVXPY conic problem first

    Returns a RebalanceResult.
    """
    n = len(pools)
    if n < 2:
        raise ValueError("Need at least 2 pools")

    status = "optimal"
    obj_val = None

    if run_conic:
        # --- Independent per-token reserve scaling ---
        if scale_x is None:
            scale_x = max(p.x for p in pools)
        if scale_y is None:
            scale_y = max(p.y for p in pools)

        if scale_x <= 0 or scale_y <= 0:
            raise ValueError("All reserves must be positive")

        xs = np.array([p.x / scale_x for p in pools])
        ys = np.array([p.y / scale_y for p in pools])
        ws = np.array([p.weight for p in pools])
        # Scaled k_i: k_i / (scale_x * scale_y)
        ks_scaled = xs * ys

        # --- CVXPY variables (scaled) ---
        x_ = cp.Variable(n, pos=True, name="x")
        y_ = cp.Variable(n, pos=True, name="y")

        # Objective: maximize sum w_i (log(x_i' * scale_x) + log(y_i' * scale_y))
        # Constant terms do not affect the argmin/argmax
        objective = cp.Maximize(cp.sum(cp.multiply(ws, cp.log(x_) + cp.log(y_))))

        # Constraints
        constraints = []
        for i in range(n):
            constraints.append(
                cp.geo_mean(cp.vstack([x_[i], y_[i]])) >= math.sqrt(ks_scaled[i])
            )
        constraints.append(cp.sum(x_) == np.sum(xs))
        constraints.append(cp.sum(y_) == np.sum(ys))

        # Solve via Clarabel
        solver_kwargs: dict = {"verbose": verbose}
        if solver == "CLARABEL":
            solver_kwargs["tol_gap_abs"] = 1e-9
            solver_kwargs["tol_gap_rel"] = 1e-9
            solver_kwargs["tol_feas"] = 1e-9

        prob = cp.Problem(objective, constraints)
        try:
            prob.solve(solver=solver, **solver_kwargs)
            status = prob.status
            if prob.value is not None:
                # Add back scaling constants
                obj_val = float(prob.value) + float(
                    np.sum(ws * (math.log(scale_x) + math.log(scale_y)))
                )
        except cp.SolverError as e:
            status = f"SolverError: {e}"

        if status not in (cp.OPTIMAL, cp.OPTIMAL_INACCURATE):
            return RebalanceResult(
                pools_before=pools,
                pools_after=pools,
                status=status or "failed",
            )

    # --- Project to exact KKT water-filling solution ---
    pools_after = solve_water_filling(pools)

    if obj_val is None:
        obj_val = sum(p.weight * (math.log(p.x) + math.log(p.y)) for p in pools_after)

    # --- Arbitrage-free check (1 bp tolerance) ---
    arb_ok, arb_detail = is_arbitrage_free(pools_after, tolerance_bps=1.0)

    return RebalanceResult(
        pools_before=pools,
        pools_after=pools_after,
        status=status,
        objective_value=obj_val,
        is_arbitrage_free=arb_ok,
        arb_free_check_detail=arb_detail,
    )


# ---------------------------------------------------------------------------
# Convenience functions
# ---------------------------------------------------------------------------

def check_conservation(result: RebalanceResult, tol: float = 1e-6) -> Tuple[bool, str]:
    """Check that total token-0 and token-1 are conserved."""
    before = result.pools_before
    after = result.pools_after

    sum_x_before = sum(p.x for p in before)
    sum_x_after = sum(p.x for p in after)
    sum_y_before = sum(p.y for p in before)
    sum_y_after = sum(p.y for p in after)

    dx = abs(sum_x_after - sum_x_before)
    dy = abs(sum_y_after - sum_y_before)

    ok_x = dx <= tol * sum_x_before if sum_x_before > 0 else dx <= tol
    ok_y = dy <= tol * sum_y_before if sum_y_before > 0 else dy <= tol

    detail = (
        f"token-0: before={sum_x_before:.8f} after={sum_x_after:.8f} "
        f"delta={dx:.2e} ok={ok_x} | "
        f"token-1: before={sum_y_before:.8f} after={sum_y_after:.8f} "
        f"delta={dy:.2e} ok={ok_y}"
    )
    return (ok_x and ok_y), detail


def check_k_monotonicity(result: RebalanceResult) -> Tuple[bool, str]:
    """Check that every pool's k did not decrease."""
    details = []
    all_ok = True
    for i, (pb, pa) in enumerate(zip(result.pools_before, result.pools_after)):
        # Allow machine-epsilon tolerance (1e-12 relative)
        ok = pa.k >= pb.k * (1.0 - 1e-12)
        details.append(
            f"Pool {i}: k_before={pb.k:.6f} k_after={pa.k:.6f} ok={ok}"
        )
        if not ok:
            all_ok = False
    return all_ok, "; ".join(details)


def decompose_transfers_to_hops(
    transfers_x: List[int],
    transfers_y: List[int],
) -> List[dict]:
    """
    Decompose integer token deltas (lamports / micro-tokens) into pairwise TransferHop records.
    transfers_x[i] > 0 means pool i receives token X; < 0 means pool i sends token X.
    """
    hops = []
    # Token X hops
    senders_x = [[i, -val] for i, val in enumerate(transfers_x) if val < 0]
    receivers_x = [[i, val] for i, val in enumerate(transfers_x) if val > 0]
    s_idx, r_idx = 0, 0
    while s_idx < len(senders_x) and r_idx < len(receivers_x):
        amount = min(senders_x[s_idx][1], receivers_x[r_idx][1])
        if amount > 0:
            hops.append({
                "from_pool": int(senders_x[s_idx][0]),
                "to_pool": int(receivers_x[r_idx][0]),
                "is_token_x": True,
                "amount": int(amount),
            })
            senders_x[s_idx][1] -= amount
            receivers_x[r_idx][1] -= amount
        if senders_x[s_idx][1] == 0:
            s_idx += 1
        if receivers_x[r_idx][1] == 0:
            r_idx += 1

    # Token Y hops
    senders_y = [[i, -val] for i, val in enumerate(transfers_y) if val < 0]
    receivers_y = [[i, val] for i, val in enumerate(transfers_y) if val > 0]
    s_idx, r_idx = 0, 0
    while s_idx < len(senders_y) and r_idx < len(receivers_y):
        amount = min(senders_y[s_idx][1], receivers_y[r_idx][1])
        if amount > 0:
            hops.append({
                "from_pool": int(senders_y[s_idx][0]),
                "to_pool": int(receivers_y[r_idx][0]),
                "is_token_x": False,
                "amount": int(amount),
            })
            senders_y[s_idx][1] -= amount
            receivers_y[r_idx][1] -= amount
        if senders_y[s_idx][1] == 0:
            s_idx += 1
        if receivers_y[r_idx][1] == 0:
            r_idx += 1

    return hops


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="PoolSync Convex Reference Solver CLI")
    parser.add_argument("--json-pools", type=str, help="JSON list of pools")
    parser.add_argument("--pools-file", type=str, help="Path to JSON file containing list of pools")
    parser.add_argument("--raw-units", action="store_true", help="Inputs are in raw integer units (lamports/micro-units)")
    parser.add_argument("--decimals-x", type=int, default=9, help="Decimals of token X (default: 9)")
    parser.add_argument("--decimals-y", type=int, default=6, help="Decimals of token Y (default: 6)")
    parser.add_argument("--demo-vector-4", action="store_true", help="Run with SPEC Test Vector 4")

    args = parser.parse_args()

    if args.demo_vector_4:
        pools = [
            Pool(x=1000.0, y=100000.0, weight=1.0),
            Pool(x=1000.0, y=105000.0, weight=1.0),
        ]
        result = solve(pools)
        print(f"Status: {result.status}")
        print(f"Common price: {result.pools_after[0].spot_price:.4f}")
        print(f"Arbitrage free: {result.is_arbitrage_free}")
        print(f"Pool 0 after: x={result.pools_after[0].x:.6f}, y={result.pools_after[0].y:.6f}, k={result.pools_after[0].k:.2f}")
        print(f"Pool 1 after: x={result.pools_after[1].x:.6f}, y={result.pools_after[1].y:.6f}, k={result.pools_after[1].k:.2f}")
        print(f"Transfers X: {result.transfers_x}")
        print(f"Transfers Y: {result.transfers_y}")
        sys.exit(0)

    if args.pools_file:
        with open(args.pools_file, "r", encoding="utf-8") as pf:
            args.json_pools = pf.read()

    if args.json_pools:
        raw_pools = json.loads(args.json_pools)
        factor_x = 10**args.decimals_x if args.raw_units else 1.0
        factor_y = 10**args.decimals_y if args.raw_units else 1.0

        pools = [
            Pool(
                x=float(p["x"]) / factor_x,
                y=float(p["y"]) / factor_y,
                weight=float(p.get("weight", 1.0)),
            )
            for p in raw_pools
        ]
        result = solve(pools)

        # Compute integer transfers in raw units
        raw_transfers_x = [int(round(tx * factor_x)) for tx in result.transfers_x]
        raw_transfers_y = [int(round(ty * factor_y)) for ty in result.transfers_y]

        # Enforce exact zero sum integer conservation
        if sum(raw_transfers_x) != 0:
            raw_transfers_x[0] -= sum(raw_transfers_x)
        if sum(raw_transfers_y) != 0:
            raw_transfers_y[0] -= sum(raw_transfers_y)

        # Enforce strict integer k-monotonicity per pool (rounding in pool's favor per SPEC Check 4)
        for i in range(len(raw_pools)):
            rx = int(raw_pools[i]["x"])
            ry = int(raw_pools[i]["y"])
            old_k = rx * ry
            new_x = rx + raw_transfers_x[i]
            new_y = ry + raw_transfers_y[i]
            if new_x * new_y < old_k:
                if raw_transfers_x[i] > 0 and raw_transfers_y[i] < 0:
                    needed_x = (old_k + new_y - 1) // new_y
                    diff = needed_x - new_x
                    raw_transfers_x[i] += diff
                    other = (i + 1) % len(raw_pools)
                    raw_transfers_x[other] -= diff
                elif raw_transfers_y[i] > 0 and raw_transfers_x[i] < 0:
                    needed_y = (old_k + new_x - 1) // new_x
                    diff = needed_y - new_y
                    raw_transfers_y[i] += diff
                    other = (i + 1) % len(raw_pools)
                    raw_transfers_y[other] -= diff

        hops = decompose_transfers_to_hops(raw_transfers_x, raw_transfers_y)

        output = {
            "status": result.status,
            "is_arbitrage_free": result.is_arbitrage_free,
            "common_price": result.pools_after[0].spot_price,
            "pools_before": [{"x": p.x, "y": p.y, "k": p.k, "price": p.spot_price} for p in result.pools_before],
            "pools_after": [{"x": p.x, "y": p.y, "k": p.k, "price": p.spot_price} for p in result.pools_after],
            "raw_transfers_x": raw_transfers_x,
            "raw_transfers_y": raw_transfers_y,
            "transfer_hops": hops,
        }
        print(json.dumps(output, indent=2))
