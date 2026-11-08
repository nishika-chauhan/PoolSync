use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct RebalancePolicy {
    /// Whether this pool has opted in to multi-pool rebalancing
    pub opt_in: bool,
    /// Authorized coordinator identity allowed to submit rebalances for this pool
    pub coordinator: Pubkey,
    /// Minimum reserve of token X permitted after rebalancing
    pub min_reserve_x: u64,
    /// Minimum reserve of token Y permitted after rebalancing
    pub min_reserve_y: u64,
    /// Maximum transfer allowed per rebalance as a fraction of current reserves in bps (10_000 = 100%)
    pub max_transfer_bps: u16,
    /// Maximum allowed staleness in slots between expected solve state and on-chain execution
    pub max_staleness_slots: u64,
    /// Minimum required k gain (new_k - old_k >= min_k_gain)
    pub min_k_gain: u128,
    /// Explicit pause flag for the pool
    pub paused: bool,
}

impl Default for RebalancePolicy {
    fn default() -> Self {
        Self {
            opt_in: true,
            coordinator: Pubkey::default(),
            min_reserve_x: 0,
            min_reserve_y: 0,
            max_transfer_bps: 10_000, // 100%
            max_staleness_slots: 150, // ~1 minute
            min_k_gain: 0,
            paused: false,
        }
    }
}

#[account]
#[derive(Debug, InitSpace)]
pub struct Pool {
    /// Mint address of base token X
    pub token_mint_x: Pubkey,
    /// Mint address of quote token Y
    pub token_mint_y: Pubkey,
    /// PDA token vault for token X
    pub token_vault_x: Pubkey,
    /// PDA token vault for token Y
    pub token_vault_y: Pubkey,
    /// PDA LP token mint
    pub lp_mint: Pubkey,
    /// Current cached reserve of token X
    pub reserve_x: u64,
    /// Current cached reserve of token Y
    pub reserve_y: u64,
    /// Trading fee in basis points (e.g., 30 = 0.30%)
    pub fee_bps: u16,
    /// k invariant at last update: reserve_x * reserve_y (u128)
    pub k_last: u128,
    /// Slot of last state-modifying instruction
    pub last_slot: u64,
    /// Rebalance configuration policy
    pub policy: RebalancePolicy,
    /// Pool index/identifier allowing multiple pools for the same mint pair
    pub index: u8,
    /// PDA bump for the pool account
    pub bump: u8,
    /// PDA bump for vault X
    pub vault_x_bump: u8,
    /// PDA bump for vault Y
    pub vault_y_bump: u8,
    /// PDA bump for LP mint
    pub lp_mint_bump: u8,
}

impl Pool {
    pub const SEED_PREFIX: &'static [u8] = b"pool";
    pub const VAULT_X_PREFIX: &'static [u8] = b"vault_x";
    pub const VAULT_Y_PREFIX: &'static [u8] = b"vault_y";
    pub const LP_MINT_PREFIX: &'static [u8] = b"lp_mint";

    /// Computes the constant-product invariant: x * y in u128 math.
    pub fn compute_k(x: u64, y: u64) -> u128 {
        (x as u128).saturating_mul(y as u128)
    }

    /// Verifies that the pool is not paused.
    pub fn assert_not_paused(&self) -> Result<()> {
        require!(!self.policy.paused, crate::errors::PoolSyncError::PoolPaused);
        Ok(())
    }
}
