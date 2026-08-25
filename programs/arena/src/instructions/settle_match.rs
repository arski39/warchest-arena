use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::ArenaError;

/// Server signs sha256(JSON.stringify({ matchKey, winner, standings })).
/// TODO (Phase 2, task 6): verify sig on-chain via Ed25519Program sibling instruction.
#[derive(Accounts)]
pub struct SettleMatch<'info> {
    #[account(
        mut,
        constraint = match_account.status == MatchStatus::InProgress @ ArenaError::AlreadySettled,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub winner_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettleMatch>, winner: Pubkey, standings: Vec<u64>) -> Result<()> {
    let m = &mut ctx.accounts.match_account;

    let mut found = false;
    for i in 0..m.player_count as usize {
        if m.players[i] == winner {
            found = true;
            break;
        }
    }
    require!(found, ArenaError::WinnerNotInMatch);

    let _ = standings; // consumed by sig verification in Phase 2

    let pot = ctx.accounts.vault.amount;
    let rake = pot * m.rake_bps as u64 / 10_000;
    let payout = pot - rake;

    let authority_key = m.authority;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump = m.bump;
    let seeds: &[&[u8]] = &[b"match", authority_key.as_ref(), &nonce_bytes, &[bump]];
    let signer = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.winner_token.to_account_info(),
                authority: ctx.accounts.match_account.to_account_info(),
            },
            signer,
        ),
        payout,
    )?;

    if rake > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_token.to_account_info(),
                    authority: ctx.accounts.match_account.to_account_info(),
                },
                signer,
            ),
            rake,
        )?;
    }

    m.status = MatchStatus::Settled;
    Ok(())
}
