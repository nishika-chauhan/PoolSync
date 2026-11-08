use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::Pool;
use crate::errors::PoolSyncError;
use crate::events::SwapEvent;

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [Pool::SEED_PREFIX, pool.token_mint_x.as_ref(), pool.token_mint_y.as_ref(), &[pool.index]],
        bump = pool.bump,
        has_one = token_vault_x @ PoolSyncError::InvalidTokenAccounts,
        has_one = token_vault_y @ PoolSyncError::InvalidTokenAccounts,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        token::mint = pool.token_mint_x,
        token::authority = user,
    )]
    pub user_token_x: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = pool.token_mint_y,
        token::authority = user,
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

    pub token_program: Program<'info, Token>,
}

pub fn process_swap(
    ctx: Context<Swap>,
    amount_in: u64,
    min_amount_out: u64,
    input_is_x: bool,
) -> Result<()> {
    ctx.accounts.pool.assert_not_paused()?;
    require!(amount_in > 0, PoolSyncError::ZeroAmount);

    let pool = &ctx.accounts.pool;
    let reserve_x = pool.reserve_x;
    let reserve_y = pool.reserve_y;
    require!(reserve_x > 0 && reserve_y > 0, PoolSyncError::ZeroAmount);

    let fee_factor = (10_000u64)
        .checked_sub(pool.fee_bps as u64)
        .ok_or(PoolSyncError::MathOverflow)?;

    let amount_in_eff = (amount_in as u128)
        .checked_mul(fee_factor as u128)
        .ok_or(PoolSyncError::MathOverflow)?;

    let (amount_out, new_reserve_x, new_reserve_y) = if input_is_x {
        // User inputs X, receives Y
        let numerator = amount_in_eff
            .checked_mul(reserve_y as u128)
            .ok_or(PoolSyncError::MathOverflow)?;
        let denominator = (reserve_x as u128)
            .checked_mul(10_000)
            .ok_or(PoolSyncError::MathOverflow)?
            .checked_add(amount_in_eff)
            .ok_or(PoolSyncError::MathOverflow)?;

        let out = (numerator / denominator) as u64;
        let new_x = reserve_x.checked_add(amount_in).ok_or(PoolSyncError::MathOverflow)?;
        let new_y = reserve_y.checked_sub(out).ok_or(PoolSyncError::MathOverflow)?;
        (out, new_x, new_y)
    } else {
        // User inputs Y, receives X
        let numerator = amount_in_eff
            .checked_mul(reserve_x as u128)
            .ok_or(PoolSyncError::MathOverflow)?;
        let denominator = (reserve_y as u128)
            .checked_mul(10_000)
            .ok_or(PoolSyncError::MathOverflow)?
            .checked_add(amount_in_eff)
            .ok_or(PoolSyncError::MathOverflow)?;

        let out = (numerator / denominator) as u64;
        let new_x = reserve_x.checked_sub(out).ok_or(PoolSyncError::MathOverflow)?;
        let new_y = reserve_y.checked_add(amount_in).ok_or(PoolSyncError::MathOverflow)?;
        (out, new_x, new_y)
    };

    require!(amount_out >= min_amount_out, PoolSyncError::SlippageExceeded);
    require!(amount_out > 0, PoolSyncError::ZeroAmount);

    // Constant product invariant check: new_k >= old_k
    let new_k = Pool::compute_k(new_reserve_x, new_reserve_y);
    require!(new_k >= pool.k_last, PoolSyncError::KDecreased);

    let seeds = &[
        Pool::SEED_PREFIX,
        ctx.accounts.pool.token_mint_x.as_ref(),
        ctx.accounts.pool.token_mint_y.as_ref(),
        &[ctx.accounts.pool.index],
        &[ctx.accounts.pool.bump],
    ];
    let signer = &[&seeds[..]];

    if input_is_x {
        // Transfer X from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_x.to_account_info(),
                    to: ctx.accounts.token_vault_x.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Transfer Y from vault to user
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
            amount_out,
        )?;
    } else {
        // Transfer Y from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_y.to_account_info(),
                    to: ctx.accounts.token_vault_y.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Transfer X from vault to user
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
            amount_out,
        )?;
    }

    let fee_paid = (amount_in as u128 * pool.fee_bps as u128 / 10_000) as u64;

    let pool = &mut ctx.accounts.pool;
    pool.reserve_x = new_reserve_x;
    pool.reserve_y = new_reserve_y;
    pool.k_last = new_k;
    pool.last_slot = Clock::get()?.slot;

    emit!(SwapEvent {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        input_is_x,
        amount_in,
        amount_out,
        fee_paid,
        new_reserve_x,
        new_reserve_y,
        new_k,
    });

    Ok(())
}
