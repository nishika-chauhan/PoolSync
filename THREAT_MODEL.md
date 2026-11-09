# PoolSync: Security, Risk Analysis & Threat Model

This document outlines the security architecture, threat vectors, mathematical guarantees, and operational risk boundaries for the PoolSync constant-product AMM atomic rebalancing protocol.

---

## 1. Adversary Model & Assumptions

We assume a Byzantine environment typical of public blockchain infrastructure:
- **Validators & Searchers:** May reorder, delay, or sandwich transactions submitted to the mempool.
- **Off-Chain Keepers & Solvers:** May be buggy, compromised, malicious, or out-of-sync.
- **Coordinators:** May attempt to act maliciously or collude with external actors to extract liquidity from opted-in pools.
- **Smart Contract Security:** We assume the underlying Solana runtime, BPF loader, and SPL Token program operate according to their formal specifications.

**Core Design Tenet:** *The on-chain program never trusts the off-chain solver or coordinator. All safety and invariant guarantees are verified deterministically by the Solana runtime before any state change or token transfer is committed.*

---

## 2. Threat Vectors & Defense Mechanisms

### Threat 1: Malicious Coordinator / Unauthorized Fund Extraction
* **Attack Scenario:** An authorized coordinator submits a rebalance instruction attempting to transfer pool reserves into an external attacker-controlled account, or transfer funds from Pool 0 to Pool 1 without an offsetting reverse transfer.
* **Defense & Mitigations:**
  - **Check 1 (Opt-in & Authority Verification):** The program verifies that every pool included in the rebalance has `opted_in == true` and that the caller's pubkey matches `policy.authorized_coordinator`.
  - **Check 3 (Exact Token Conservation):** The program verifies:
    $$\sum_{i=1}^N \Delta x_i = 0 \quad \text{and} \quad \sum_{i=1}^N \Delta y_i = 0$$
    Every transfer destination `to_pool` must be an index within the participating set ($0 \le \text{to\_pool} < N$). External account transfers are strictly rejected with `ErrorCode::ConservationViolation`.
  - **Check 4 ($k$-Monotonicity):** Even within the participating set, no pool can have its invariant reduced. If Pool 0 sends Token X to Pool 1, it must receive sufficient Token Y such that:
    $$(R_{x,0} + \Delta x_0)(R_{y,0} + \Delta y_0) \ge R_{x,0} \cdot R_{y,0}$$
    Failure throws `ErrorCode::KDecreased`.

---

### Threat 2: Front-Running & Sandwich Attacks on Rebalances
* **Attack Scenario:** An MEV searcher detects a pending `rebalance` transaction in the mempool and executes a swap on Pool 0 immediately before the rebalance, attempting to profit from the anticipated reserve shift.
* **Defense & Mitigations:**
  - **Direct Vault CPI Execution:** Rebalances do not execute swaps and do not interact with user-facing swap routing. They execute direct vault-to-vault CPI transfers between SPL token vaults.
  - **Live Reserve Invariant Validation:** Check 4 ($k$-monotonicity) and Check 6 (price convergence) are evaluated against the *actual runtime reserves* at execution time. If an intervening swap altered $R_{x,0}$ or $R_{y,0}$, the pre-computed solver transfers $(\Delta x, \Delta y)$ will fail either Check 4 or Check 6, causing the transaction to revert entirely with zero state changes.
  - **Slot-Bounded Policies:** Pools can configure `policy.min_interval_slots` to enforce rate-limiting between successive rebalances.

---

### Threat 3: Discretization & Integer Rounding Exploitation
* **Attack Scenario:** In floating-point mathematics, an optimal rebalance may require fractional token transfers (e.g., $12.19734...$ lamports). Naive integer truncation (`floor`) could cause a pool's post-rebalance product $k_{\text{post}}$ to fall short of $k_{\text{pre}}$ by a few lamports, creating an incremental drain over millions of transactions.
* **Defense & Mitigations:**
  - **Exact Ceiling Projection in Solver:** The reference solver computes:
    $$\text{needed\_x} = \left\lceil \frac{R_{x,\text{old}} \cdot R_{y,\text{old}}}{R_{y,\text{new}}} \right\rceil = \left\lfloor \frac{R_{x,\text{old}} \cdot R_{y,\text{old}} + R_{y,\text{new}} - 1}{R_{y,\text{new}}} \right\rfloor$$
    Any rounding adjustment is strictly added to the constrained pool and subtracted from the surplus pool, ensuring:
    $$k_{\text{post}} \ge k_{\text{pre}} \quad \forall i \in \{1, \dots, N\}$$
  - **On-Chain Single-Lamport Invariant Enforcement:** The on-chain program validates Check 4 using full 128-bit unsigned integer arithmetic (`u128`), ensuring no rounding error can pass undetected.

---

### Threat 4: Loss-Versus-Rebalancing (LVR) Under Extreme Market Volatility
* **Attack Scenario:** During a severe macro price crash (e.g., external market drops 20% in seconds), rebalancing two internal pools to each other might equalize internal spot prices to a stale level, leaving both pools exposed to toxic order flow from external arbitrageurs.
* **Defense & Mitigations:**
  - **Check 5 (Policy Bounds & Max Divergence):** The governance policy defines `policy.max_price_divergence_bps` (e.g. 1,000 bps) and `policy.max_single_rebalance_bps` (e.g. 2,000 bps). If the price divergence exceeds the safe threshold, or if the required transfer exceeds the single rebalance cap, the instruction reverts with `ErrorCode::PriceDivergenceExceeded` or `ErrorCode::SingleRebalanceCapExceeded`.
  - **Circuit Breakers:** Pool creators can pause rebalancing instantly via `pause_rebalance` or set `opted_in = false` without impacting ordinary user swaps, deposits, or withdrawals.

---

### Threat 5: Denial of Service (DoS) & Spam Rebalancing
* **Attack Scenario:** An attacker spams no-op or micro-divergence rebalances to congest the validator or exhaust compute budget.
* **Defense & Mitigations:**
  - **Keeper Divergence Threshold:** The keeper service strictly enforces a minimum trigger threshold (default: 5 bps spread). Rebalances with spreads $< 5$ bps are skipped as no-ops.
  - **Compute Budget Optimization:** The entire 7-check invariant engine and vault CPI transfers execute within ~45,000 compute units (well below Solana's 200,000 CU default per transaction).
  - **Transaction Fee Burden:** Gas fees on Solana are paid by the submitting keeper/coordinator, making spam economically irrational.

---

## 3. Invariant Defense Matrix

| On-Chain Invariant | Rust Implementation | Error Code | Threats Addressed |
| :--- | :--- | :--- | :--- |
| **Check 1: Opt-In & Coordinator** | `pool.opted_in && authority == policy.coordinator` | `UnauthorizedCoordinator`, `PoolNotOptedIn` | Malicious rebalancer, unauthorized state manipulation |
| **Check 2: Reserve Consistency** | `vault.key() == pool.vault_x && vault.mint == pool.mint_x` | `InvalidVault`, `MintMismatch` | Account substitution, fake token injection |
| **Check 3: Token Conservation** | `sum(dx) == 0 && sum(dy) == 0 && to_pool < N` | `ConservationViolation` | Token leakage, unauthorized external withdrawals |
| **Check 4: $k$-Monotonicity** | `(Rx + dx)(Ry + dy) >= Rx * Ry` | `KDecreased` | LP dilution, reserve extraction, rounding drain |
| **Check 5: Policy Bounds** | `abs(dx) <= Rx * max_single_bps / 10000` | `SingleRebalanceCapExceeded`, `PriceDivergenceExceeded` | Volatility shock, runaway rebalance |
| **Check 6: Arbitrage-Free** | `abs(Rx_i * Ry_j - Rx_j * Ry_i) <= tolerance` | `ArbitrageRemaining` | Incomplete rebalance, biased pricing |
| **Check 7: Counterfactual Arb Event** | `emit!(RebalanceEvent { arb_profit, ... })` | N/A (Telemetry) | Transparency, MEV retention auditability |

---

## 4. Operational Recommendations & Guardrails

1. **Devnet & Localnet Prototyping Only:** Under no circumstances should this contract be deployed to Solana Mainnet-Beta without a comprehensive third-party cryptographic and smart contract audit.
2. **Keypair Safety:** Never fund testing keypairs with real mainnet SOL. Keep all private keys and mnemonic phrases strictly inside `.gitignore` (`keys/*.json`, `*.keypair.json`).
3. **Conservative Policy Limits:** Production deployments should enforce a strict `max_single_rebalance_bps` (e.g. $\le 500$ bps) and rate-limiting (`min_interval_slots` $\ge 10$) to prevent rapid consecutive state shifts.
