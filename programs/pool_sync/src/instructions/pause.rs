use anchor_lang::prelude::*;
use crate::state::Pool;
use crate::errors::PoolSyncError;
use crate::events::PauseToggledEvent;

#[derive(Accounts)]
pub struct Pause<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [Pool::SEED_PREFIX, pool.token_mint_x.as_ref(), pool.token_mint_y.as_ref(), &[pool.index]],
        bump = pool.bump,
        constraint = pool.policy.coordinator == authority.key() @ PoolSyncError::UnauthorizedCoordinator
    )]
    pub pool: Account<'info, Pool>,
}

pub fn process_pause(ctx: Context<Pause>, paused: bool) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.policy.paused = paused;
    pool.last_slot = Clock::get()?.slot;

    emit!(PauseToggledEvent {
        pool: pool.key(),
        paused,
    });

    Ok(())
}
