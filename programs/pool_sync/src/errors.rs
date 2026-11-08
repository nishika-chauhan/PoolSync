use anchor_lang::prelude::*;

#[error_code]
pub enum PoolSyncError {
    #[msg("Pool is currently paused")]
    PoolPaused,

    #[msg("Expected reserves do not match current pool reserves (stale solve)")]
    StaleReserves,

    #[msg("Pool has not opted into rebalancing")]
    PoolNotOptedIn,

    #[msg("Signer is not the authorized coordinator for this pool")]
    UnauthorizedCoordinator,

    #[msg("Per-token conservation violated across pools")]
    ConservationViolation,

    #[msg("Per-pool invariant violated: new k is less than old k")]
    KDecreased,

    #[msg("Pool policy bound violated: reserves would fall below minimum")]
    MinReservesBreached,

    #[msg("Pool policy bound violated: transfer exceeds maximum reserve fraction")]
    MaxTransferExceeded,

    #[msg("Pool policy bound violated: slot exceeds maximum staleness")]
    StaleSlot,

    #[msg("Pool policy bound violated: k gain below minimum threshold")]
    MinKGainNotMet,

    #[msg("Post-state is not arbitrage-free: spot prices do not agree within tolerance")]
    NotArbitrageFree,

    #[msg("Provided amount must be greater than zero")]
    ZeroAmount,

    #[msg("Pool reserves must remain strictly positive")]
    ZeroReserves,

    #[msg("Mathematical calculation overflowed or resulted in invalid state")]
    MathOverflow,

    #[msg("Token-2022 and non-standard tokens with fees or hooks are strictly prohibited")]
    UnsupportedTokenProgram,

    #[msg("Slippage tolerance exceeded during swap or liquidity provision")]
    SlippageExceeded,

    #[msg("Invalid token mint or vault accounts provided")]
    InvalidTokenAccounts,
}
