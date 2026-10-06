//! HAAS booking escrow.
//!
//! One escrow per booking. The hirer locks SPL tokens (USDC) in a vault owned by a
//! PDA; the HAAS arbiter (`authority`) releases them to the worker once the delivery
//! is verified, or cancels early to refund the hirer. Once `deadline` has passed and
//! nothing was released, ANYONE can refund the hirer: the hirer's money never depends
//! on the HAAS server staying up.
//!
//! Rules, in full:
//! - `initialize_and_deposit` (hirer signs): creates the escrow PDA
//!   `["escrow", authority, booking_hash]` and its vault (the PDA's associated token
//!   account), and moves `amount` from the hirer. `deadline` must be in the future.
//! - `release(result_hash)` (authority or hirer signs): pays the whole vault to the
//!   payee fixed at deposit time. If the hirer committed to an `expected_result_hash`,
//!   `result_hash` must match it. Only while funded and before the deadline.
//! - `refund()` (anyone signs, pays the fee): after the deadline, returns the vault
//!   to the hirer.
//! - `cancel()` (authority signs): returns the vault to the hirer at any time.
//!
//! Settling closes the vault (its rent goes back to the hirer) and keeps the escrow
//! account as a permanent record with its final status and result hash.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("9hzyeY6LPaQzJWszBjtYU17sHN2XmQD6FmyJFCNrs727");

pub const ESCROW_SEED: &[u8] = b"escrow";

#[program]
pub mod haas_escrow {
    use super::*;

    pub fn initialize_and_deposit(
        ctx: Context<InitializeAndDeposit>,
        booking_hash: [u8; 32],
        amount: u64,
        deadline: i64,
        expected_result_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(deadline > now, EscrowError::DeadlineInPast);

        let escrow = &mut ctx.accounts.escrow;
        escrow.authority = ctx.accounts.authority.key();
        escrow.hirer = ctx.accounts.hirer.key();
        escrow.payee = ctx.accounts.payee.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.booking_hash = booking_hash;
        escrow.amount = amount;
        escrow.deadline = deadline;
        escrow.created_at = now;
        escrow.expected_result_hash = expected_result_hash;
        escrow.result_hash = [0; 32];
        escrow.status = EscrowStatus::Funded;
        escrow.bump = ctx.bumps.escrow;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.hirer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.hirer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(EscrowFunded {
            escrow: escrow.key(),
            booking_hash,
            authority: escrow.authority,
            hirer: escrow.hirer,
            payee: escrow.payee,
            mint: escrow.mint,
            amount,
            deadline,
            expected_result_hash,
        });
        Ok(())
    }

    pub fn release(ctx: Context<Release>, result_hash: [u8; 32]) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let signer = ctx.accounts.signer.key();
        require!(escrow.status == EscrowStatus::Funded, EscrowError::NotFunded);
        require!(signer == escrow.authority || signer == escrow.hirer, EscrowError::Unauthorized);
        require!(Clock::get()?.unix_timestamp < escrow.deadline, EscrowError::DeadlinePassed);
        if escrow.expected_result_hash != [0; 32] {
            require!(result_hash == escrow.expected_result_hash, EscrowError::ResultHashMismatch);
        }

        let amount = ctx.accounts.vault.amount;
        payout(
            &ctx.accounts.escrow,
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            ctx.accounts.payee_token.to_account_info(),
            ctx.accounts.hirer.to_account_info(),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Released;
        escrow.result_hash = result_hash;
        emit!(EscrowReleased {
            escrow: escrow.key(),
            booking_hash: escrow.booking_hash,
            payee: escrow.payee,
            amount,
            result_hash,
            by: signer,
        });
        Ok(())
    }

    /// Permissionless refund once the deadline has passed.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.escrow.deadline,
            EscrowError::DeadlineNotReached
        );
        settle_refund(ctx, RefundReason::Timeout)
    }

    /// Early refund by the arbiter (booking cancelled, not approved, platform failure).
    pub fn cancel(ctx: Context<Refund>) -> Result<()> {
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.escrow.authority, EscrowError::Unauthorized);
        settle_refund(ctx, RefundReason::Cancelled)
    }
}

fn settle_refund(ctx: Context<Refund>, reason: RefundReason) -> Result<()> {
    require!(ctx.accounts.escrow.status == EscrowStatus::Funded, EscrowError::NotFunded);
    let amount = ctx.accounts.vault.amount;
    payout(
        &ctx.accounts.escrow,
        &ctx.accounts.token_program,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        ctx.accounts.hirer_token.to_account_info(),
        ctx.accounts.hirer.to_account_info(),
        amount,
    )?;
    let escrow = &mut ctx.accounts.escrow;
    escrow.status = match reason {
        RefundReason::Timeout => EscrowStatus::Refunded,
        RefundReason::Cancelled => EscrowStatus::Cancelled,
    };
    emit!(EscrowRefunded {
        escrow: escrow.key(),
        booking_hash: escrow.booking_hash,
        hirer: escrow.hirer,
        amount,
        reason,
        by: ctx.accounts.signer.key(),
    });
    Ok(())
}

/// Moves the whole vault to `to`, then closes the vault with its rent going to the hirer.
fn payout<'info>(
    escrow: &Account<'info, Escrow>,
    token_program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    to: AccountInfo<'info>,
    rent_to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[ESCROW_SEED, escrow.authority.as_ref(), escrow.booking_hash.as_ref(), &[escrow.bump]];
    let signer = &[seeds];
    if amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    to,
                    authority: escrow.to_account_info(),
                },
                signer,
            ),
            amount,
            mint.decimals,
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount { account: vault.to_account_info(), destination: rent_to, authority: escrow.to_account_info() },
        signer,
    ))
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(booking_hash: [u8; 32])]
pub struct InitializeAndDeposit<'info> {
    #[account(mut)]
    pub hirer: Signer<'info>,
    /// CHECK: the HAAS arbiter that may release or cancel; only its key is stored.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the wallet paid on release; only its key is stored.
    pub payee: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = hirer, token::token_program = token_program)]
    pub hirer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = hirer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, authority.key().as_ref(), booking_hash.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// init_if_needed: anyone can create an ATA for any owner, so a plain `init` could be griefed.
    #[account(
        init_if_needed,
        payer = hirer,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    /// The arbiter or the hirer (checked in the handler).
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.authority.as_ref(), escrow.booking_hash.as_ref()],
        bump = escrow.bump,
        has_one = mint,
        has_one = hirer
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: receives the vault's rent; must be the hirer recorded on the escrow (has_one).
    #[account(mut)]
    pub hirer: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = payee_token.owner == escrow.payee @ EscrowError::WrongPayee
    )]
    pub payee_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Anyone for `refund` (after the deadline); the arbiter for `cancel`.
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.authority.as_ref(), escrow.booking_hash.as_ref()],
        bump = escrow.bump,
        has_one = mint,
        has_one = hirer
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: receives the vault's rent; must be the hirer recorded on the escrow (has_one).
    #[account(mut)]
    pub hirer: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = hirer_token.owner == escrow.hirer @ EscrowError::WrongRefundAccount
    )]
    pub hirer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

// --------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub authority: Pubkey,
    pub hirer: Pubkey,
    pub payee: Pubkey,
    pub mint: Pubkey,
    /// sha256 of the HAAS booking id.
    pub booking_hash: [u8; 32],
    pub amount: u64,
    /// Unix seconds. Release is allowed before it, permissionless refund from it on.
    pub deadline: i64,
    pub created_at: i64,
    /// All zeros: any result is accepted. Otherwise release must present this hash.
    pub expected_result_hash: [u8; 32],
    /// The hash presented at release (sha256 of the verified delivery).
    pub result_hash: [u8; 32],
    pub status: EscrowStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum EscrowStatus {
    Funded,
    Released,
    Refunded,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RefundReason {
    Timeout,
    Cancelled,
}

// -------------------------------------------------------------------- events

#[event]
pub struct EscrowFunded {
    pub escrow: Pubkey,
    pub booking_hash: [u8; 32],
    pub authority: Pubkey,
    pub hirer: Pubkey,
    pub payee: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub expected_result_hash: [u8; 32],
}

#[event]
pub struct EscrowReleased {
    pub escrow: Pubkey,
    pub booking_hash: [u8; 32],
    pub payee: Pubkey,
    pub amount: u64,
    pub result_hash: [u8; 32],
    pub by: Pubkey,
}

#[event]
pub struct EscrowRefunded {
    pub escrow: Pubkey,
    pub booking_hash: [u8; 32],
    pub hirer: Pubkey,
    pub amount: u64,
    pub reason: RefundReason,
    pub by: Pubkey,
}

// -------------------------------------------------------------------- errors

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Escrow is not funded (already released or refunded)")]
    NotFunded,
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Deadline has passed; the escrow can only be refunded")]
    DeadlinePassed,
    #[msg("Deadline has not passed yet")]
    DeadlineNotReached,
    #[msg("Result hash does not match the one committed at deposit")]
    ResultHashMismatch,
    #[msg("Token account is not owned by the payee")]
    WrongPayee,
    #[msg("Token account is not owned by the hirer")]
    WrongRefundAccount,
}
