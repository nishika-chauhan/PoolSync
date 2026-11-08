use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::token::{self, Token, Transfer};
use crate::errors::PoolSyncError;
use crate::events::RebalanceEvent;
use crate::state::Pool;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolTransfer {
    /// Index of source pool in remaining accounts (0..N-1)
    pub from_pool: u8,
    /// Index of destination pool in remaining accounts (0..N-1)
    pub to_pool: u8,
    /// True if transferring token X; false if transferring token Y
    pub is_token_x: bool,
    /// Amount of tokens to transfer
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExpectedReserves {
    pub reserve_x: u64,
    pub reserve_y: u64,
}

#[derive(Accounts)]
pub struct Rebalance<'info> {
    pub coordinator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    // Remaining accounts: for each pool i:
    // [pool_account, token_vault_x, token_vault_y]
}

pub fn process_rebalance<'info>(
    ctx: Context<'_, '_, '_, 'info, Rebalance<'info>>,
    transfers: Vec<PoolTransfer>,
    expected_reserves: Vec<ExpectedReserves>,
    max_price_diff_bps: Option<u16>,
) -> Result<()> {
    let remaining_accounts = ctx.remaining_accounts;
    require!(
        remaining_accounts.len() % 3 == 0,
        PoolSyncError::InvalidTokenAccounts
    );
    let n = remaining_accounts.len() / 3;
    require!(n >= 2 && n <= 5, PoolSyncError::InvalidTokenAccounts);
    require_eq!(expected_reserves.len(), n, PoolSyncError::StaleReserves);

    let tol_bps = max_price_diff_bps.unwrap_or(20).min(100) as u128; // Default 20 bps (0.20%) tolerance

    // 1. Parse and validate all pool accounts and vaults
    let mut pools: Vec<Pool> = Vec::with_capacity(n);
    let mut pool_keys: Vec<Pubkey> = Vec::with_capacity(n);
    let current_slot = Clock::get()?.slot;

    for i in 0..n {
        let pool_acc_info = &remaining_accounts[3 * i];
        let vault_x_info = &remaining_accounts[3 * i + 1];
        let vault_y_info = &remaining_accounts[3 * i + 2];

        require_eq!(
            *pool_acc_info.owner,
            crate::ID,
            PoolSyncError::InvalidTokenAccounts
        );

        let pool_data = pool_acc_info.try_borrow_data()?;
        let mut disc = [0u8; 8];
        disc.copy_from_slice(&pool_data[..8]);
        require!(
            disc == Pool::DISCRIMINATOR,
            PoolSyncError::InvalidTokenAccounts
        );
        let pool: Pool = Pool::try_deserialize(&mut &pool_data[..])?;
        drop(pool_data);

        // CHECK 1: Opt-in and coordinator authorization
        require!(pool.policy.opt_in, PoolSyncError::PoolNotOptedIn);
        require_keys_eq!(
            ctx.accounts.coordinator.key(),
            pool.policy.coordinator,
            PoolSyncError::UnauthorizedCoordinator
        );

        // CHECK 2: Expected reserves match current pool reserves
        require_eq!(
            pool.reserve_x,
            expected_reserves[i].reserve_x,
            PoolSyncError::StaleReserves
        );
        require_eq!(
            pool.reserve_y,
            expected_reserves[i].reserve_y,
            PoolSyncError::StaleReserves
        );

        // Verify vault accounts match pool state
        require_keys_eq!(
            vault_x_info.key(),
            pool.token_vault_x,
            PoolSyncError::InvalidTokenAccounts
        );
        require_keys_eq!(
            vault_y_info.key(),
            pool.token_vault_y,
            PoolSyncError::InvalidTokenAccounts
        );

        pool_keys.push(pool_acc_info.key());
        pools.push(pool);
    }

    // 2. Compute net adjustments and CHECK 3: Token conservation
    let mut net_x: Vec<i128> = vec![0; n];
    let mut net_y: Vec<i128> = vec![0; n];
    let mut outgoing_x: Vec<u64> = vec![0; n];
    let mut outgoing_y: Vec<u64> = vec![0; n];

    for t in &transfers {
        let from = t.from_pool as usize;
        let to = t.to_pool as usize;
        require!(from < n && to < n, PoolSyncError::InvalidTokenAccounts);
        require!(from != to, PoolSyncError::InvalidTokenAccounts);
        require!(t.amount > 0, PoolSyncError::ZeroAmount);

        if t.is_token_x {
            net_x[from] = net_x[from]
                .checked_sub(t.amount as i128)
                .ok_or(PoolSyncError::MathOverflow)?;
            net_x[to] = net_x[to]
                .checked_add(t.amount as i128)
                .ok_or(PoolSyncError::MathOverflow)?;
            outgoing_x[from] = outgoing_x[from]
                .checked_add(t.amount)
                .ok_or(PoolSyncError::MathOverflow)?;
        } else {
            net_y[from] = net_y[from]
                .checked_sub(t.amount as i128)
                .ok_or(PoolSyncError::MathOverflow)?;
            net_y[to] = net_y[to]
                .checked_add(t.amount as i128)
                .ok_or(PoolSyncError::MathOverflow)?;
            outgoing_y[from] = outgoing_y[from]
                .checked_add(t.amount)
                .ok_or(PoolSyncError::MathOverflow)?;
        }
    }

    // Conservation check: sum of net transfers for each token must be exactly 0
    let sum_net_x: i128 = net_x.iter().sum();
    let sum_net_y: i128 = net_y.iter().sum();
    require_eq!(sum_net_x, 0, PoolSyncError::ConservationViolation);
    require_eq!(sum_net_y, 0, PoolSyncError::ConservationViolation);

    // 3. Compute new reserves, verify CHECK 4 (k-monotonicity) and CHECK 5 (policy bounds)
    let mut new_reserves_x: Vec<u64> = Vec::with_capacity(n);
    let mut new_reserves_y: Vec<u64> = Vec::with_capacity(n);
    let mut pre_k: Vec<u128> = Vec::with_capacity(n);
    let mut post_k: Vec<u128> = Vec::with_capacity(n);

    for i in 0..n {
        let pool = &pools[i];

        // CHECK 5a: Pool not paused
        pool.assert_not_paused()?;

        // CHECK 5b: Staleness in slots
        let staleness = current_slot.saturating_sub(pool.last_slot);
        require!(
            staleness <= pool.policy.max_staleness_slots,
            PoolSyncError::StaleSlot
        );

        let new_x_i128 = (pool.reserve_x as i128)
            .checked_add(net_x[i])
            .ok_or(PoolSyncError::MathOverflow)?;
        let new_y_i128 = (pool.reserve_y as i128)
            .checked_add(net_y[i])
            .ok_or(PoolSyncError::MathOverflow)?;

        require!(new_x_i128 > 0 && new_y_i128 > 0, PoolSyncError::ZeroReserves);
        let new_x = new_x_i128 as u64;
        let new_y = new_y_i128 as u64;

        // CHECK 5c: Minimum reserves policy
        require!(
            new_x >= pool.policy.min_reserve_x,
            PoolSyncError::MinReservesBreached
        );
        require!(
            new_y >= pool.policy.min_reserve_y,
            PoolSyncError::MinReservesBreached
        );

        // CHECK 5d: Maximum transfer as a fraction of reserves
        let max_transfer_x = ((pool.reserve_x as u128)
            * (pool.policy.max_transfer_bps as u128))
            / 10_000;
        require!(
            (outgoing_x[i] as u128) <= max_transfer_x,
            PoolSyncError::MaxTransferExceeded
        );

        let max_transfer_y = ((pool.reserve_y as u128)
            * (pool.policy.max_transfer_bps as u128))
            / 10_000;
        require!(
            (outgoing_y[i] as u128) <= max_transfer_y,
            PoolSyncError::MaxTransferExceeded
        );

        // CHECK 4: Per-pool k-monotonicity (new_k >= old_k)
        let old_k = (pool.reserve_x as u128)
            .checked_mul(pool.reserve_y as u128)
            .ok_or(PoolSyncError::MathOverflow)?;
        let cur_new_k = (new_x as u128)
            .checked_mul(new_y as u128)
            .ok_or(PoolSyncError::MathOverflow)?;

        require!(cur_new_k >= old_k, PoolSyncError::KDecreased);

        // CHECK 5e: Minimum k gain policy
        require!(
            cur_new_k.saturating_sub(old_k) >= pool.policy.min_k_gain,
            PoolSyncError::MinKGainNotMet
        );

        new_reserves_x.push(new_x);
        new_reserves_y.push(new_y);
        pre_k.push(old_k);
        post_k.push(cur_new_k);
    }

    // 4. CHECK 6: Arbitrage-free post-state via cross-multiplication with no division
    for i in 0..n {
        for j in (i + 1)..n {
            if pools[i].token_mint_x == pools[j].token_mint_x
                && pools[i].token_mint_y == pools[j].token_mint_y
            {
                // Spot prices: P_i = new_y[i] / new_x[i], P_j = new_y[j] / new_x[j]
                // Cross-multiplication: prod_i = new_y[i] * new_x[j], prod_j = new_y[j] * new_x[i]
                let prod_i = (new_reserves_y[i] as u128)
                    .checked_mul(new_reserves_x[j] as u128)
                    .ok_or(PoolSyncError::MathOverflow)?;
                let prod_j = (new_reserves_y[j] as u128)
                    .checked_mul(new_reserves_x[i] as u128)
                    .ok_or(PoolSyncError::MathOverflow)?;

                let diff = if prod_i >= prod_j {
                    prod_i - prod_j
                } else {
                    prod_j - prod_i
                };
                let max_prod = prod_i.max(prod_j);

                // Exact cross-multiplication tolerance check: 10_000 * diff <= max_prod * tol_bps
                require!(
                    diff.saturating_mul(10_000) <= max_prod.saturating_mul(tol_bps),
                    PoolSyncError::NotArbitrageFree
                );
            }
        }
    }

    // 5. Execute physical token transfers between pool vaults via CPI
    for t in &transfers {
        let from = t.from_pool as usize;
        let to = t.to_pool as usize;
        let from_pool = &pools[from];

        let from_vault_acc = if t.is_token_x {
            &remaining_accounts[3 * from + 1]
        } else {
            &remaining_accounts[3 * from + 2]
        };

        let to_vault_acc = if t.is_token_x {
            &remaining_accounts[3 * to + 1]
        } else {
            &remaining_accounts[3 * to + 2]
        };

        let from_pool_acc = &remaining_accounts[3 * from];

        let seeds = &[
            Pool::SEED_PREFIX,
            from_pool.token_mint_x.as_ref(),
            from_pool.token_mint_y.as_ref(),
            &[from_pool.index],
            &[from_pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: from_vault_acc.to_account_info(),
            to: to_vault_acc.to_account_info(),
            authority: from_pool_acc.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, t.amount)?;
    }

    // 6. Update on-chain state for each pool account
    for i in 0..n {
        let pool_acc_info = &remaining_accounts[3 * i];
        let mut pool_data = pool_acc_info.try_borrow_mut_data()?;

        let mut pool = pools[i].clone();
        pool.reserve_x = new_reserves_x[i];
        pool.reserve_y = new_reserves_y[i];
        pool.k_last = post_k[i];
        pool.last_slot = current_slot;

        // Serialize back into the account buffer
        let mut writer = &mut pool_data[8..];
        pool.serialize(&mut writer)?;
    }

    // 7. CHECK 7: Compute counterfactual arbitrage profit and emit RebalanceEvent
    let counterfactual_arb_profit_y = if n >= 2
        && pools[0].token_mint_x == pools[1].token_mint_x
        && pools[0].token_mint_y == pools[1].token_mint_y
    {
        compute_counterfactual_arbitrage_profit(
            pools[0].reserve_x,
            pools[0].reserve_y,
            pools[1].reserve_x,
            pools[1].reserve_y,
        )
    } else {
        0
    };

    let pre_reserves_x: Vec<u64> = pools.iter().map(|p| p.reserve_x).collect();
    let pre_reserves_y: Vec<u64> = pools.iter().map(|p| p.reserve_y).collect();

    emit!(RebalanceEvent {
        coordinator: ctx.accounts.coordinator.key(),
        pool_count: n as u8,
        pools: pool_keys,
        pre_reserves_x,
        pre_reserves_y,
        post_reserves_x: new_reserves_x,
        post_reserves_y: new_reserves_y,
        pre_k,
        post_k,
        counterfactual_arb_profit_y,
        slot: current_slot,
    });

    Ok(())
}

/// Computes the counterfactual arbitrage profit in token Y that a bot would extract
/// from the pre-state of two same-pair pools.
///
/// Closed-form constant-product arbitrage:
///   p_C = y_C / x_C < y_E / x_E = p_E
///   r = sqrt(k_E / k_C)
///   dx = (r * x_C - x_E) / (1 + r) = (sqrt(k_E) * x_C - sqrt(k_C) * x_E) / (sqrt(k_E) + sqrt(k_C))
///   dy_in = k_C / (x_C - dx) - y_C
///   dy_out = y_E - k_E / (x_E + dx)
///   profit = dy_out - dy_in
#[inline(never)]
fn compute_counterfactual_arbitrage_profit(
    x0: u64,
    y0: u64,
    x1: u64,
    y1: u64,
) -> u128 {
    if x0 == 0 || y0 == 0 || x1 == 0 || y1 == 0 {
        return 0;
    }
    // Spot prices: p0 = y0 / x0, p1 = y1 / x1
    // p0 < p1 <=> y0 * x1 < y1 * x0
    let (xc, yc, xe, ye) = if (y0 as u128) * (x1 as u128) <= (y1 as u128) * (x0 as u128) {
        (x0 as u128, y0 as u128, x1 as u128, y1 as u128)
    } else {
        (x1 as u128, y1 as u128, x0 as u128, y0 as u128)
    };

    let kc = xc * yc;
    let ke = xe * ye;

    let sqrt_kc = integer_sqrt_u128(kc);
    let sqrt_ke = integer_sqrt_u128(ke);

    // dx = (sqrt_ke * xc - sqrt_kc * xe) / (sqrt_ke + sqrt_kc)
    let num = sqrt_ke.saturating_mul(xc);
    let sub = sqrt_kc.saturating_mul(xe);
    if num <= sub {
        return 0;
    }
    let den = sqrt_ke + sqrt_kc;
    if den == 0 {
        return 0;
    }
    let dx = (num - sub) / den;
    if dx == 0 || dx >= xc {
        return 0;
    }

    let dy_in = (kc / (xc - dx)).saturating_sub(yc);
    let dy_out = ye.saturating_sub(ke / (xe + dx));

    dy_out.saturating_sub(dy_in)
}

#[inline(never)]
fn integer_sqrt_u128(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = (n >> 1) + 1;
    let mut y = (x + n / x) >> 1;
    while y < x {
        x = y;
        y = (x + n / x) >> 1;
    }
    x
}
