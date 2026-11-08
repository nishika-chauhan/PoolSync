use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::token::{self, InitializeAccount, InitializeMint, Mint, Token, TokenAccount};
use crate::state::{Pool, RebalancePolicy};
use crate::errors::PoolSyncError;
use crate::events::PoolInitializedEvent;

#[derive(Accounts)]
#[instruction(fee_bps: u16, coordinator: Pubkey, index: u8)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [Pool::SEED_PREFIX, token_mint_x.key().as_ref(), token_mint_y.key().as_ref(), &[index]],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mint::token_program = token_program
    )]
    pub token_mint_x: Box<Account<'info, Mint>>,

    #[account(
        mint::token_program = token_program
    )]
    pub token_mint_y: Box<Account<'info, Mint>>,

    /// CHECK: Created and initialized via CPI in handler
    #[account(mut)]
    pub token_vault_x: UncheckedAccount<'info>,

    /// CHECK: Created and initialized via CPI in handler
    #[account(mut)]
    pub token_vault_y: UncheckedAccount<'info>,

    /// CHECK: Created and initialized via CPI in handler
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[inline(never)]
fn create_token_vault<'info>(
    payer: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    rent_account: &AccountInfo<'info>,
    rent: &Rent,
    seed_prefix: &[u8],
    bump: u8,
) -> Result<()> {
    let pool_key = pool.key();
    let signer_seeds: &[&[u8]] = &[seed_prefix, pool_key.as_ref(), &[bump]];

    let lamports = rent.minimum_balance(TokenAccount::LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            vault.key,
            lamports,
            TokenAccount::LEN as u64,
            token_program.key,
        ),
        &[payer.clone(), vault.clone(), system_program.clone()],
        &[signer_seeds],
    )?;

    token::initialize_account(CpiContext::new(
        token_program.clone(),
        InitializeAccount {
            account: vault.clone(),
            mint: mint.clone(),
            authority: pool.clone(),
            rent: rent_account.clone(),
        },
    ))?;

    Ok(())
}

#[inline(never)]
fn create_lp_mint<'info>(
    payer: &AccountInfo<'info>,
    lp_mint: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    rent_account: &AccountInfo<'info>,
    rent: &Rent,
    bump: u8,
) -> Result<()> {
    let pool_key = pool.key();
    let signer_seeds: &[&[u8]] = &[Pool::LP_MINT_PREFIX, pool_key.as_ref(), &[bump]];

    let lamports = rent.minimum_balance(Mint::LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            lp_mint.key,
            lamports,
            Mint::LEN as u64,
            token_program.key,
        ),
        &[payer.clone(), lp_mint.clone(), system_program.clone()],
        &[signer_seeds],
    )?;

    token::initialize_mint(
        CpiContext::new(
            token_program.clone(),
            InitializeMint {
                mint: lp_mint.clone(),
                rent: rent_account.clone(),
            },
        ),
        9,
        pool.key,
        Some(pool.key),
    )?;

    Ok(())
}

pub fn process_initialize_pool(
    ctx: Context<InitializePool>,
    fee_bps: u16,
    coordinator: Pubkey,
    index: u8,
) -> Result<()> {
    require!(fee_bps <= 10_000, PoolSyncError::MathOverflow);
    
    // Strict standard SPL token check (reject Token-2022)
    require_keys_eq!(
        *ctx.accounts.token_program.key,
        anchor_spl::token::ID,
        PoolSyncError::UnsupportedTokenProgram
    );

    let (expected_vault_x, vault_x_bump) = Pubkey::find_program_address(
        &[Pool::VAULT_X_PREFIX, ctx.accounts.pool.key().as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(ctx.accounts.token_vault_x.key(), expected_vault_x, PoolSyncError::InvalidTokenAccounts);

    let (expected_vault_y, vault_y_bump) = Pubkey::find_program_address(
        &[Pool::VAULT_Y_PREFIX, ctx.accounts.pool.key().as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(ctx.accounts.token_vault_y.key(), expected_vault_y, PoolSyncError::InvalidTokenAccounts);

    let (expected_lp_mint, lp_mint_bump) = Pubkey::find_program_address(
        &[Pool::LP_MINT_PREFIX, ctx.accounts.pool.key().as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(ctx.accounts.lp_mint.key(), expected_lp_mint, PoolSyncError::InvalidTokenAccounts);

    create_token_vault(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.token_vault_x.to_account_info(),
        &ctx.accounts.token_mint_x.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.rent.to_account_info(),
        &ctx.accounts.rent,
        Pool::VAULT_X_PREFIX,
        vault_x_bump,
    )?;

    create_token_vault(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.token_vault_y.to_account_info(),
        &ctx.accounts.token_mint_y.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.rent.to_account_info(),
        &ctx.accounts.rent,
        Pool::VAULT_Y_PREFIX,
        vault_y_bump,
    )?;

    create_lp_mint(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.lp_mint.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.rent.to_account_info(),
        &ctx.accounts.rent,
        lp_mint_bump,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.token_mint_x = ctx.accounts.token_mint_x.key();
    pool.token_mint_y = ctx.accounts.token_mint_y.key();
    pool.token_vault_x = ctx.accounts.token_vault_x.key();
    pool.token_vault_y = ctx.accounts.token_vault_y.key();
    pool.lp_mint = ctx.accounts.lp_mint.key();
    pool.reserve_x = 0;
    pool.reserve_y = 0;
    pool.fee_bps = fee_bps;
    pool.k_last = 0;
    pool.last_slot = Clock::get()?.slot;
    pool.index = index;
    pool.bump = ctx.bumps.pool;
    pool.vault_x_bump = vault_x_bump;
    pool.vault_y_bump = vault_y_bump;
    pool.lp_mint_bump = lp_mint_bump;

    pool.policy = RebalancePolicy {
        opt_in: true,
        coordinator,
        min_reserve_x: 0,
        min_reserve_y: 0,
        max_transfer_bps: 10_000,
        max_staleness_slots: 150,
        min_k_gain: 0,
        paused: false,
    };

    emit!(PoolInitializedEvent {
        pool: pool.key(),
        token_mint_x: pool.token_mint_x,
        token_mint_y: pool.token_mint_y,
        fee_bps,
        coordinator,
    });

    Ok(())
}