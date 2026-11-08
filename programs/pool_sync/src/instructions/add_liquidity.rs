use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use crate::state::Pool;
use crate::errors::PoolSyncError;
use crate::events::LiquidityAddedEvent;

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
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

pub fn process_add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_x: u64,
    amount_y: u64,
    min_lp_out: u64,
) -> Result<()> {
    ctx.accounts.pool.assert_not_paused()?;
    require!(amount_x > 0 && amount_y > 0, PoolSyncError::ZeroAmount);

    let total_lp = ctx.accounts.lp_mint.supply;
    let pool = &ctx.accounts.pool;

    let lp_to_mint: u64 = if total_lp == 0 {
        // Initial liquidity: geometric mean sqrt(amount_x * amount_y)
        let k_init = (amount_x as u128)
            .checked_mul(amount_y as u128)
            .ok_or(PoolSyncError::MathOverflow)?;
        integer_sqrt(k_init) as u64
    } else {
        // Proportional deposit
        let lp_x = (amount_x as u128)
            .checked_mul(total_lp as u128)
            .ok_or(PoolSyncError::MathOverflow)?
            .checked_div(pool.reserve_x as u128)
            .ok_or(PoolSyncError::MathOverflow)?;

        let lp_y = (amount_y as u128)
            .checked_mul(total_lp as u128)
            .ok_or(PoolSyncError::MathOverflow)?
            .checked_div(pool.reserve_y as u128)
            .ok_or(PoolSyncError::MathOverflow)?;

        std::cmp::min(lp_x, lp_y) as u64
    };

    require!(lp_to_mint >= min_lp_out, PoolSyncError::SlippageExceeded);
    require!(lp_to_mint > 0, PoolSyncError::ZeroAmount);

    // Transfer token X to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_x.to_account_info(),
                to: ctx.accounts.token_vault_x.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        amount_x,
    )?;

    // Transfer token Y to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_y.to_account_info(),
                to: ctx.accounts.token_vault_y.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        ),
        amount_y,
    )?;

    // Mint LP tokens to provider using pool PDA seeds
    let seeds = &[
        Pool::SEED_PREFIX,
        ctx.accounts.pool.token_mint_x.as_ref(),
        ctx.accounts.pool.token_mint_y.as_ref(),
        &[ctx.accounts.pool.index],
        &[ctx.accounts.pool.bump],
    ];
    let signer = &[&seeds[..]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.user_lp.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer,
        ),
        lp_to_mint,
    )?;

    // Update pool reserves and k_last
    let pool = &mut ctx.accounts.pool;
    pool.reserve_x = pool.reserve_x.checked_add(amount_x).ok_or(PoolSyncError::MathOverflow)?;
    pool.reserve_y = pool.reserve_y.checked_add(amount_y).ok_or(PoolSyncError::MathOverflow)?;
    pool.k_last = Pool::compute_k(pool.reserve_x, pool.reserve_y);
    pool.last_slot = Clock::get()?.slot;

    emit!(LiquidityAddedEvent {
        pool: pool.key(),
        provider: ctx.accounts.provider.key(),
        amount_x,
        amount_y,
        lp_minted: lp_to_mint,
        new_reserve_x: pool.reserve_x,
        new_reserve_y: pool.reserve_y,
        new_k: pool.k_last,
    });

    Ok(())
}

fn integer_sqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x0 = n / 2;
    if x0 == 0 {
        return 1;
    }
    let mut x1 = (x0 + n / x0) / 2;
    while x1 < x0 {
        x0 = x1;
        x1 = (x0 + n / x0) / 2;
    }
    x0
}
