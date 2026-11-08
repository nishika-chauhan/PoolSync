use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::Pool;
use crate::errors::PoolSyncError;
use crate::events::LiquidityRemovedEvent;

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [Pool::SEED_PREFIX, pool.token_mint_x.as_ref(), pool.token_mint_y.as_ref(), &[pool.index]],
        bump = pool.bump,
        has_one = token_vault_x @ PoolSyncError::InvalidTokenAccounts,
        has_one = token_vault_y @ PoolSyncError::InvalidTokenAccounts,
        has_one = lp_mint @ PoolSyncError::InvalidTokenAccounts,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        token::mint = pool.token_mint_x,
        token::authority = provider,
    )]
    pub user_token_x: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = pool.token_mint_y,
        token::authority = provider,
    )]
    pub user_token_y: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [Pool::VAULT_X_PREFIX, pool.key().as_ref()],
        bump = pool.vault_x_bump,
    )]
    pub token_vault_x: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [Pool::VAULT_Y_PREFIX, pool.key().as_ref()],
        bump = pool.vault_y_bump,
    )]
    pub token_vault_y: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [Pool::LP_MINT_PREFIX, pool.key().as_ref()],
        bump = pool.lp_mint_bump,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = pool.lp_mint,
        token::authority = provider,
    )]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn process_remove_liquidity(
    ctx: Context<RemoveLiquidity>,
    lp_amount: u64,
    min_amount_x: u64,
    min_amount_y: u64,
) -> Result<()> {
    ctx.accounts.pool.assert_not_paused()?;
    require!(lp_amount > 0, PoolSyncError::ZeroAmount);

    let total_lp = ctx.accounts.lp_mint.supply;
    require!(total_lp > 0, PoolSyncError::ZeroAmount);

    let pool = &ctx.accounts.pool;

    let amount_x = ((lp_amount as u128)
        .checked_mul(pool.reserve_x as u128)
        .ok_or(PoolSyncError::MathOverflow)?
        / (total_lp as u128)) as u64;

    let amount_y = ((lp_amount as u128)
        .checked_mul(pool.reserve_y as u128)
        .ok_or(PoolSyncError::MathOverflow)?
        / (total_lp as u128)) as u64;

    require!(amount_x >= min_amount_x && amount_y >= min_amount_y, PoolSyncError::SlippageExceeded);
    require!(amount_x > 0 || amount_y > 0, PoolSyncError::ZeroAmount);

    // Burn LP tokens from provider
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.user_lp.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        lp_amount,
    )?;

    // Transfer token X to user from PDA vault
    let seeds = &[
        Pool::SEED_PREFIX,
        ctx.accounts.pool.token_mint_x.as_ref(),
        ctx.accounts.pool.token_mint_y.as_ref(),
        &[ctx.accounts.pool.index],
        &[ctx.accounts.pool.bump],
    ];
    let signer = &[&seeds[..]];

    if amount_x > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_vault_x.to_account_info(),
                    to: ctx.accounts.user_token_x.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            amount_x,
        )?;
    }

    if amount_y > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_vault_y.to_account_info(),
                    to: ctx.accounts.user_token_y.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            amount_y,
        )?;
    }

    let pool = &mut ctx.accounts.pool;
    pool.reserve_x = pool.reserve_x.checked_sub(amount_x).ok_or(PoolSyncError::MathOverflow)?;
    pool.reserve_y = pool.reserve_y.checked_sub(amount_y).ok_or(PoolSyncError::MathOverflow)?;
    pool.k_last = Pool::compute_k(pool.reserve_x, pool.reserve_y);
    pool.last_slot = Clock::get()?.slot;

    emit!(LiquidityRemovedEvent {
        pool: pool.key(),
        provider: ctx.accounts.provider.key(),
        lp_burned: lp_amount,
        amount_x,
        amount_y,
        new_reserve_x: pool.reserve_x,
        new_reserve_y: pool.reserve_y,
        new_k: pool.k_last,
    });

    Ok(())
}
