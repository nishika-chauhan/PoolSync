use anchor_lang::prelude::*;
use crate::state::{Pool, RebalancePolicy};
use crate::errors::PoolSyncError;
use crate::events::PolicyUpdatedEvent;

#[derive(Accounts)]
pub struct SetPolicy<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [Pool::SEED_PREFIX, pool.token_mint_x.as_ref(), pool.token_mint_y.as_ref(), &[pool.index]],
        bump = pool.bump,
        constraint = pool.policy.coordinator == authority.key() @ PoolSyncError::UnauthorizedCoordinator
    )]
    pub pool: Account<'info, Pool>,
}

pub fn process_set_policy(ctx: Context<SetPolicy>, new_policy: RebalancePolicy) -> Result<()> {
    require!(new_policy.max_transfer_bps <= 10_000, PoolSyncError::MathOverflow);
    let pool = &mut ctx.accounts.pool;
    pool.policy = new_policy;
    pool.last_slot = Clock::get()?.slot;

    emit!(PolicyUpdatedEvent {
        pool: pool.key(),
        new_policy,
    });

    Ok(())
}
