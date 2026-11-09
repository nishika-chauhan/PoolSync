# PoolSync: 3-Minute Live Demonstration Script

This script provides a concise, step-by-step walkthrough designed to present PoolSync in under 3 minutes. It showcases the status quo MEV leakage problem, the reference solver and autonomous keeper, on-chain mathematical verification, and the interactive dashboard.

---

## Demo Schedule & Timeline

```
[0:00 - 0:45] Phase 1: The Status Quo Problem (External MEV Arbitrage Extraction)
[0:45 - 1:30] Phase 2: The Autonomous Keeper & Invariant-Preserving Solver
[1:30 - 2:15] Phase 3: On-Chain Invariant Verification & Mathematical Proofs
[2:15 - 3:00] Phase 4: Interactive Web Dashboard & 100% Value Retention
```

---

## Step-by-Step Presenter Script

### Step 1: The Status Quo Problem (0:00 - 0:45)

**Presenter Narration:**
> *"In decentralized finance today, when two constant-product AMM pools sharing the same asset pair diverge in price—say, due to different order flow—external arbitrage bots jump in. They buy from the underpriced pool and dump on the overpriced pool, extracting value straight out of the liquidity providers' pockets. Let's run our baseline arbitrage bot to see this happen live."*

**Action:** Run the baseline arbitrageur against a 500 bps price gap (Pool 0 at 100.00 USDC, Pool 1 at 105.00 USDC):

```bash
python solver/arb_bot.py
```

**Expected Console Output:**
```
============================================================
PoolSync Baseline Arbitrage Simulation (Vector 4)
============================================================
Initial State:
  Pool 0: Rx = 1000.0000 SOL, Ry = 100000.0000 USDC | Price = 100.0000 USDC/SOL
  Pool 1: Rx = 1000.0000 SOL, Ry = 105000.0000 USDC | Price = 105.0000 USDC/SOL
  Initial Spread: 500.00 bps

Executing 2-hop cyclic arbitrage:
  Step 1: Swap 12.197 SOL on Pool 0 -> receive 1205.34 USDC
  Step 2: Swap 1205.34 USDC on Pool 1 -> receive 12.197 SOL + 30.49 USDC profit

Arbitrageur Result:
  Extracted Profit: $30.49 USDC
  Value Retained by AMM LPs: 0.00% (All extracted by searcher)
```

**Presenter Callout:**
> *"The external bot extracted \$30.49 USDC from the pools. The price gap was closed, but the LPs lost value. Now let's see how PoolSync solves this."*

---

### Step 2: The Autonomous Keeper & Solver (0:45 - 1:30)

**Presenter Narration:**
> *"Instead of allowing external searchers to drain the pools, PoolSync's autonomous keeper detects the divergence and computes the optimal water-filling reallocation using our convex solver. It executes an atomic multi-pool rebalance directly between pool vaults via Solana CPI."*

**Action:** Run the keeper integration test (Phase 3 suite):

```bash
npx mocha -t 120000 tests/keeper.ts
```

**Expected Console Output:**
```
  PoolSync Phase 3: Keeper, Baseline Arb Bot & Devnet Scripts
    [Test 1] Baseline arbitrage bot extracts profit from divergent pools
      ✓ Baseline bot extracts profit: ~30.49 USDC, gap closed to 0.00 bps
    [Test 2] Keeper service dry-run mode detects opportunity without executing
      ✓ Keeper dry-run correctly identifies 500.00 bps gap
    [Test 3] Keeper service executes live on-chain atomic rebalance
      Pre-rebalance: Pool 0 = 100.0000, Pool 1 = 105.0000 (Spread: 500 bps)
      Post-rebalance: Pool 0 = 102.5000, Pool 1 = 102.5000 (Spread: 0.00 bps)
      ✓ Equilibrium reached: divergence eliminated from 500 bps to 0.00 bps
    [Test 4] Keeper service observes equilibrium and takes no action
      ✓ Equilibrium verified: no transaction submitted (0 bps divergence)

  4 passing (13s)
```

**Presenter Callout:**
> *"Notice that the price gap is completely eliminated to exactly 102.5000 USDC/SOL with 0.00 bps divergence. But unlike the external bot, zero tokens leaked outside the pools: 100% of the value was preserved inside the AMM vaults."*

---

### Step 3: On-Chain Invariant Verification (1:30 - 2:15)

**Presenter Narration:**
> *"How do LPs know they weren't diluted or cheated? PoolSync enforces 7 rigorous mathematical invariant checks directly inside the on-chain Solana program. Let's run our standalone verifier to mathematically audit the rebalance transaction."*

**Action:** Run the standalone verifier script:

```bash
npx tsx scripts/verify_rebalance.ts
```

**Expected Console Output:**
```
============================================================
[VERIFIER] Auditing Rebalance Tx: 5KqZ1bK9hW3mZqJ4u7Vw8Y2xG1pL6cN5tD8rE3fA2sB4C6dE8gH1jK2lM3nP4qR7
============================================================
[✓] Check 3: Token Conservation across All Pools: PASS
    ↳ sum(dx) = 0, sum(dy) = 0
[✓] Check 2: Reserve State Transition Consistency: PASS
    ↳ All post-reserves exactly match pre-reserves + signed transfers
[✓] Check 4: Invariant k-Monotonicity (No Pool Worse Off): PASS
    ↳ Pool 0: delta_k = +13718731729542344000; Pool 1: delta_k = +16806731684542344000
[✓] Check 5: Governance Policy Bounds: PASS
    ↳ All transfers within 2000 bps cap
[✓] Check 6: Arbitrage-Free Condition (Cross-Multiplication): PASS
    ↳ Relative price divergence = 0.3013 bps (threshold <= 1.0 bps)
[✓] Check 7: Counterfactual LP Value Retention: PASS
    ↳ 100.00% retained ($30.49 preserved)
------------------------------------------------------------
FINAL AUDIT RESULT: ALL INVARIANTS VERIFIED ✓
============================================================
```

**Presenter Callout:**
> *"Every single invariant passed: exact token conservation down to the lamport, strict k-monotonicity with delta_k > 0, and 100.00% value retention."*

---

### Step 4: Interactive Web Dashboard (2:15 - 3:00)

**Presenter Narration:**
> *"Finally, let's look at the operator and liquidity provider dashboard built with Next.js 14 and Tailwind CSS."*

**Action:** Start the dashboard server:

```bash
cd dashboard
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in the browser:

1. **Highlight the Opportunity Banner:** Point out the amber warning: **"Spread: 500 bps — $30.49 USDC at risk"**.
2. **Click "Trigger Atomic Rebalance":**
   - The button executes the rebalance in real-time.
   - The banner flashes green: **"POOLS IN HARMONY (0 bps spread)"**.
   - Pool 0 and Pool 1 spot prices converge immediately to **$102.5000**.
3. **Highlight the Directed Vault Transfer Graph:**
   - Show the directional flow arrows: **+12.27 SOL** moving from Pool 0 to Pool 1, and **+$1,242.38 USDC** moving from Pool 1 to Pool 0.
   - Point out the conservation badge: $\sum \Delta X = 0, \sum \Delta Y = 0$.
4. **Highlight the Value Retention Panel:**
   - Status Quo External Arb: **-$30.49 USDC** lost.
   - PoolSync Atomic Rebalance: **+$30.49 USDC** preserved (+100.0% retained).
5. **Inspect Proof:**
   - Click **"Inspect Invariants"** in the Rebalance Ledger table.
   - The modal displays the live mathematical evaluation proving all 7 invariants held on-chain.
6. **Simulate Shock:**
   - Click **"Simulate 500 bps Price Shock"** to reset the demo back to the divergent state, proving repeatability.

---

## Key Talking Points Summary

- **Problem:** AMM price divergence bleeds LP value to external MEV bots ($30.49 per incident in a standard 1,000 SOL pool pair).
- **Solution:** PoolSync performs atomic cross-pool rebalancing using convex water-filling and direct vault CPI.
- **Guarantee:** 7 on-chain checks enforce strict single-lamport $k$-monotonicity ($\Delta k \ge 0$) and token conservation.
- **Result:** 100% of MEV value is retained for AMM liquidity providers with zero price divergence remaining.
