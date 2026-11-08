use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use instructions::*;
pub use state::RebalancePolicy;

declare_id!("D2nX6JxARw7hhWvaSRgRC43tAtBRX2K6pQkbup26T4ik");

#[program]
pub mod pool_sync {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        fee_bps: u16,
        coordinator: Pubkey,
        index: u8,
    ) -> Result<()> {
        instructions::initialize_pool::process_initialize_pool(ctx, fee_bps, coordinator, index)
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_x: u64,
        amount_y: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        instructions::add_liquidity::process_add_liquidity(ctx, amount_x, amount_y, min_lp_out)
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_amount_x: u64,
        min_amount_y: u64,
    ) -> Result<()> {
        instructions::remove_liquidity::process_remove_liquidity(ctx, lp_amount, min_amount_x, min_amount_y)
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_amount_out: u64,
        input_is_x: bool,
    ) -> Result<()> {
        instructions::swap::process_swap(ctx, amount_in, min_amount_out, input_is_x)
    }

    pub fn set_policy(ctx: Context<SetPolicy>, new_policy: RebalancePolicy) -> Result<()> {
        instructions::set_policy::process_set_policy(ctx, new_policy)
    }

    pub fn pause(ctx: Context<Pause>, paused: bool) -> Result<()> {
        instructions::pause::process_pause(ctx, paused)
    }

    pub fn rebalance<'info>(
        ctx: Context<'_, '_, '_, 'info, Rebalance<'info>>,
        transfers: Vec<PoolTransfer>,
        expected_reserves: Vec<ExpectedReserves>,
        max_price_diff_bps: Option<u16>,
    ) -> Result<()> {
        instructions::rebalance::process_rebalance(ctx, transfers, expected_reserves, max_price_diff_bps)
    }
}
