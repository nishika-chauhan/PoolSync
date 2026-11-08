use anchor_lang::prelude::*;
use crate::state::RebalancePolicy;

#[event]
pub struct PoolInitializedEvent {
    pub pool: Pubkey,
    pub token_mint_x: Pubkey,
    pub token_mint_y: Pubkey,
    pub fee_bps: u16,
    pub coordinator: Pubkey,
}

#[event]
pub struct LiquidityAddedEvent {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount_x: u64,
    pub amount_y: u64,
    pub lp_minted: u64,
    pub new_reserve_x: u64,
    pub new_reserve_y: u64,
    pub new_k: u128,
}

#[event]
pub struct LiquidityRemovedEvent {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub lp_burned: u64,
    pub amount_x: u64,
    pub amount_y: u64,
    pub new_reserve_x: u64,
    pub new_reserve_y: u64,
    pub new_k: u128,
}

#[event]
pub struct SwapEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub input_is_x: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee_paid: u64,
    pub new_reserve_x: u64,
    pub new_reserve_y: u64,
    pub new_k: u128,
}

#[event]
pub struct PolicyUpdatedEvent {
    pub pool: Pubkey,
    pub new_policy: RebalancePolicy,
}

#[event]
pub struct PauseToggledEvent {
    pub pool: Pubkey,
    pub paused: bool,
}

#[event]
pub struct RebalanceEvent {
    pub coordinator: Pubkey,
    pub pool_count: u8,
    pub pools: Vec<Pubkey>,
    pub pre_reserves_x: Vec<u64>,
    pub pre_reserves_y: Vec<u64>,
    pub post_reserves_x: Vec<u64>,
    pub post_reserves_y: Vec<u64>,
    pub pre_k: Vec<u128>,
    pub post_k: Vec<u128>,
    pub counterfactual_arb_profit_y: u128,
    pub slot: u64,
}
