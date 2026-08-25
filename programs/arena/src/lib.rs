pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use instructions::{CancelMatch, CreateMatch, JoinMatch, SettleMatch};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod arena {
    use super::*;

    pub fn create_match(
        ctx: Context<CreateMatch>,
        entry_fee: u64,
        max_players: u8,
        rake_bps: u16,
        nonce: u64,
    ) -> Result<()> {
        instructions::create_match::handler(ctx, entry_fee, max_players, rake_bps, nonce)
    }

    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        instructions::join_match::handler(ctx)
    }

    pub fn settle_match(
        ctx: Context<SettleMatch>,
        winner: Pubkey,
        standings: Vec<u64>,
    ) -> Result<()> {
        instructions::settle_match::handler(ctx, winner, standings)
    }

    pub fn cancel_match(ctx: Context<CancelMatch>) -> Result<()> {
        instructions::cancel_match::handler(ctx)
    }
}
