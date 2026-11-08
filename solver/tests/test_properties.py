"""
Randomized property tests for the PoolSync solver.
Using Hypothesis to generate random pool configurations and verify:
  1. Token conservation: sum of each token unchanged
  2. k-monotonicity: every k >= original
  3. Arbitrage-free: spot prices agree within tolerance
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import math
import pytest
from hypothesis import given, settings, assume, HealthCheck
from hypothesis import strategies as st

from solver import Pool, solve, check_conservation, check_k_monotonicity, is_arbitrage_free


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Reasonable reserve range: 0.001 to 1,000,000
reserve_strategy = st.floats(min_value=0.001, max_value=1_000_000.0,
                             allow_nan=False, allow_infinity=False)
weight_strategy  = st.floats(min_value=0.1, max_value=10.0,
                             allow_nan=False, allow_infinity=False)
n_pools_strategy = st.integers(min_value=2, max_value=5)


def make_pools(draw, n):
    """Draw n pools with random reserves and weights."""
    pools = []
    for _ in range(n):
        x = draw(reserve_strategy)
        y = draw(reserve_strategy)
        w = draw(weight_strategy)
        pools.append(Pool(x, y, w))
    return pools


@st.composite
def pool_list(draw):
    n = draw(n_pools_strategy)
    return make_pools(draw, n)


# ---------------------------------------------------------------------------
# Property 1: Token conservation
# ---------------------------------------------------------------------------

@given(pools=pool_list())
@settings(
    max_examples=100,
    deadline=30_000,  # ms — solver can be slow
    suppress_health_check=[HealthCheck.too_slow],
)
def test_property_conservation(pools):
    """For any feasible pool configuration, the solver conserves both tokens."""
    result = solve(pools)
    if result.status not in ("optimal", "optimal_inaccurate"):
        # Infeasible configurations are acceptable (e.g., numerical edge cases)
        return

    cons_ok, detail = check_conservation(result, tol=1e-5)
    assert cons_ok, f"Conservation violated: {detail}\nPools: {pools}"


# ---------------------------------------------------------------------------
# Property 2: k-monotonicity
# ---------------------------------------------------------------------------

@given(pools=pool_list())
@settings(
    max_examples=100,
    deadline=30_000,
    suppress_health_check=[HealthCheck.too_slow],
)
def test_property_k_monotonicity(pools):
    """For any feasible configuration, every pool's k does not decrease."""
    result = solve(pools)
    if result.status not in ("optimal", "optimal_inaccurate"):
        return

    k_ok, detail = check_k_monotonicity(result)
    assert k_ok, f"k-monotonicity violated: {detail}\nPools: {pools}"


# ---------------------------------------------------------------------------
# Property 3: Arbitrage-free post-state
# ---------------------------------------------------------------------------

@given(pools=pool_list())
@settings(
    max_examples=100,
    deadline=30_000,
    suppress_health_check=[HealthCheck.too_slow],
)
def test_property_arbitrage_free(pools):
    """
    Post-rebalance state must be arbitrage-free.
    Paper Theorem 12: arbitrage-free ⟺ Pareto efficient under rebalancing.
    For same-pair pools: all spot prices equal (within tolerance).
    """
    result = solve(pools)
    if result.status not in ("optimal", "optimal_inaccurate"):
        return

    arb_ok, detail = is_arbitrage_free(result.pools_after, tolerance_bps=2.0)
    assert arb_ok, (
        f"Post-rebalance state not arbitrage-free:\n{detail}\n"
        f"Pools before: {[(p.x, p.y) for p in result.pools_before]}\n"
        f"Pools after:  {[(p.x, p.y) for p in result.pools_after]}"
    )


# ---------------------------------------------------------------------------
# Property 4: Positive reserves
# ---------------------------------------------------------------------------

@given(pools=pool_list())
@settings(
    max_examples=100,
    deadline=30_000,
    suppress_health_check=[HealthCheck.too_slow],
)
def test_property_positive_reserves(pools):
    """All post-rebalance reserves must be strictly positive."""
    result = solve(pools)
    if result.status not in ("optimal", "optimal_inaccurate"):
        return

    for i, pa in enumerate(result.pools_after):
        assert pa.x > 0, f"Pool {i}: x={pa.x} <= 0"
        assert pa.y > 0, f"Pool {i}: y={pa.y} <= 0"


# ---------------------------------------------------------------------------
# Property 5: Objective non-decrease (rebalance does not make things worse)
# ---------------------------------------------------------------------------

@given(pools=pool_list())
@settings(
    max_examples=50,
    deadline=30_000,
    suppress_health_check=[HealthCheck.too_slow],
)
def test_property_objective_improvement(pools):
    """
    The sum of weighted log-k should not decrease (or trivially stay the same
    if already optimal). The optimizer maximizes this, so it must be >= starting.
    """
    result = solve(pools)
    if result.status not in ("optimal", "optimal_inaccurate"):
        return

    import math
    obj_before = sum(
        p.weight * (math.log(p.x) + math.log(p.y))
        for p in result.pools_before
    )
    obj_after = sum(
        p.weight * (math.log(p.x) + math.log(p.y))
        for p in result.pools_after
    )
    assert obj_after >= obj_before - 1e-6, (
        f"Objective decreased: {obj_before:.6f} -> {obj_after:.6f}"
    )
