# haas-escrow

The on-chain escrow for HAAS booking budgets: one PDA per booking holding SPL USDC
until the HAAS arbiter releases it to the payee, or the deadline passes and anyone
can refund the hirer. All of it is in `src/lib.rs` (about 400 lines).

## Rules

| Instruction | Who signs | When | Effect |
|---|---|---|---|
| `initialize_and_deposit(booking_hash, amount, deadline, expected_result_hash)` | hirer | deadline in the future | Creates escrow PDA `["escrow", authority, sha256(bookingId)]` and its vault (the PDA's ATA); moves `amount` from the hirer. Fixes `authority`, `payee`, `mint`, `deadline`. Emits `EscrowFunded`. |
| `release(result_hash)` | authority (HAAS) or the hirer | funded, before the deadline | Pays the whole vault to the payee's token account; records `result_hash` (must equal `expected_result_hash` if the hirer committed one). Emits `EscrowReleased`. |
| `refund()` | anyone | funded, at or after the deadline | Returns the vault to the hirer. Emits `EscrowRefunded { reason: Timeout }`. |
| `cancel()` | authority | funded | Returns the vault to the hirer early (booking cancelled, not approved, failed). Emits `EscrowRefunded { reason: Cancelled }`. |

Settling closes the vault (rent back to the hirer) and keeps the escrow account as a
permanent record of the final status and result hash. Both SPL Token and Token-2022
mints work (`token_interface`, `transfer_checked`).

What it deliberately does not do: partial releases, disputes beyond "the arbiter
decides before the deadline, the hirer gets it back after", fees, or upgrades of the
terms after deposit.

## IDL

`idl/haas_escrow.json` is written to match Anchor 1.x output, so the TypeScript client
(`src/payments/escrow-program.ts`) needs no Anchor runtime. It is checked two ways:

- `src/payments/solana-program.test.ts` checks the client's discriminators, account
  order and account layout against the IDL.
- The compiler's own IDL output matches it (discriminators, account lists, args, types,
  events, errors; the CLI only adds PDA and address hints on top):

  ```bash
  cd programs/haas-escrow
  cargo test --features idl-build __anchor_private_print_idl -- --show-output --quiet
  ```

  With the Anchor CLI, `anchor build` regenerates `target/idl/haas_escrow.json`; copy it
  over `idl/haas_escrow.json` after any program change.

## Build and deploy to devnet

Status: compiles (`cargo check`, Rust 1.89, anchor-lang 1.2.0) and the IDL is
verified as above. The SBF build and deploy were not run from the development
container, whose network blocked the Solana toolchain download and the devnet RPC.
The program id in the repository (`9hzyeY6LPaQzJWszBjtYU17sHN2XmQD6FmyJFCNrs727`) is a
placeholder until someone holding its keypair deploys; the steps below create your own.

1. Toolchain (once):

   ```bash
   sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"   # Solana/Agave CLI, includes cargo-build-sbf
   cargo install --git https://github.com/solana-foundation/anchor avm --force
   avm install 1.2.0 && avm use 1.2.0
   ```

2. A funded devnet wallet:

   ```bash
   solana config set --url devnet
   solana-keygen new -o ~/.config/solana/id.json     # skip if you have one
   solana airdrop 5                                  # or https://faucet.solana.com; deploying needs about 3 SOL
   ```

3. Your own program id. This writes `target/deploy/haas_escrow-keypair.json` (keep it;
   it is gitignored) and updates `declare_id!` and `Anchor.toml`:

   ```bash
   cd programs/haas-escrow
   anchor keys sync
   ```

   Then put the new id in the three places outside the crate:
   `idl/haas_escrow.json` (`address`), `DEFAULT_ESCROW_PROGRAM_ID` in
   `src/payments/escrow-program.ts`, and the `SOLANA_ESCROW_PROGRAM_ID` default in
   `src/config.ts` (or just set `SOLANA_ESCROW_PROGRAM_ID` in `~/.haas/.env`).

4. Build, check, deploy:

   ```bash
   anchor build                                   # target/deploy/haas_escrow.so
   diff <(jq -S 'del(.address)' target/idl/haas_escrow.json) <(jq -S 'del(.address)' idl/haas_escrow.json)  # expect no difference
   anchor deploy --provider.cluster devnet
   solana program show <PROGRAM_ID>
   ```

5. Prove it end to end (throwaway 6-decimal mint, no faucet USDC needed):

   ```bash
   cd ../..
   SOLANA_ESCROW_PROGRAM_ID=<PROGRAM_ID> pnpm spike:solana
   ```

   It locks, releases with a result hash, cancels, and waits out a 45 s deadline for a
   permissionless refund, printing explorer links and a PASS/FAIL list.

6. Run HAAS with it, in `~/.haas/.env`:

   ```
   ESCROW_PROVIDER=solana-program
   SOLANA_ESCROW_PROGRAM_ID=<PROGRAM_ID>
   SOLANA_OPERATOR_SECRET=<base58 64-byte secret of the HAAS authority>
   PUBLIC_URL=https://<public https host>    # wallets fetch the Solana Pay transaction from here
   ```

   The operator key is the escrow `authority`: it can release or cancel every booking
   escrow and pays those transaction fees. The hirer pays the deposit fee and rent
   (returned when the vault closes).
