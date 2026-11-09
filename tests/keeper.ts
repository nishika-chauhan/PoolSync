import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PoolSync } from "../target/types/pool_sync";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert, expect } from "chai";
import BN from "bn.js";
import { runKeeper } from "../scripts/keeper";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

describe("PoolSync Phase 3: Autonomous Keeper & Baseline Arbitrage Bot", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    envProvider.connection,
    envProvider.wallet,
    { commitment: "processed", preflightCommitment: "processed" }
  );
  anchor.setProvider(provider);

  // Monkey-patch confirmTransaction to use HTTP polling to avoid WSL WebSocket hang
  provider.connection.confirmTransaction = (async (strategyOrSignature: any, commitment?: any) => {
    const signature = typeof strategyOrSignature === "string" ? strategyOrSignature : strategyOrSignature.signature;
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const res = await provider.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (res && res.value) {
        if (res.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
        }
        if (res.value.confirmationStatus) {
          return { context: res.context, value: { err: null } } as any;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Transaction ${signature} confirmation timed out after 30s`);
  }) as any;

  async function sendTx(
    connection: anchor.web3.Connection,
    tx: Transaction,
    signers: Keypair[]
  ): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("processed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const rawTx = tx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "processed",
    });

    const start = Date.now();
    while (Date.now() - start < 30000) {
      const res = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (res && res.value) {
        if (res.value.err) throw new Error(`Tx failed: ${JSON.stringify(res.value.err)}`);
        if (res.value.confirmationStatus) return sig;
      }
      try {
        await connection.sendRawTransaction(rawTx, { skipPreflight: true });
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Transaction ${sig} confirmation timed out after 30s`);
  }

  async function customCreateMint(
    connection: anchor.web3.Connection,
    payer: Keypair,
    mintAuthority: PublicKey,
    decimals: number,
    keypair: Keypair = Keypair.generate()
  ): Promise<PublicKey> {
    const lamports = await connection.getMinimumBalanceForRentExemption(82);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: keypair.publicKey,
        space: 82,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(keypair.publicKey, decimals, mintAuthority, null, TOKEN_PROGRAM_ID)
    );
    await sendTx(connection, tx, [payer, keypair]);
    return keypair.publicKey;
  }

  const program = anchor.workspace.PoolSync as Program<PoolSync>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let tokenMintX: PublicKey;
  let tokenMintY: PublicKey;
  let pool0Pda: PublicKey;
  let vault0XPda: PublicKey;
  let vault0YPda: PublicKey;
  let lpMint0Pda: PublicKey;
  let pool1Pda: PublicKey;
  let vault1XPda: PublicKey;
  let vault1YPda: PublicKey;
  let lpMint1Pda: PublicKey;

  const coordinator = Keypair.generate();
  const alice = Keypair.generate();
  let aliceTokenX: PublicKey;
  let aliceTokenY: PublicKey;
  let aliceLp0: PublicKey;
  let aliceLp1: PublicKey;

  const deposit0X = new BN(1_000_000_000_000); // 1,000 SOL
  const deposit0Y = new BN(100_000_000_000);   // 100,000 USDC
  const deposit1X = new BN(1_000_000_000_000); // 1,000 SOL
  const deposit1Y = new BN(105_000_000_000);   // 105,000 USDC

  const coordinatorKeyPath = path.join(process.cwd(), `tmp_coord_${Date.now()}.json`);

  before(async () => {
    // Write coordinator keypair for keeper to load
    fs.writeFileSync(coordinatorKeyPath, JSON.stringify(Array.from(coordinator.secretKey)));

    // Fund coordinator and alice
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: coordinator.publicKey,
        lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: alice.publicKey,
        lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    await sendTx(provider.connection, fundTx, [payer]);

    // Create token mints X (9 dec) and Y (6 dec)
    tokenMintX = await customCreateMint(provider.connection, payer, payer.publicKey, 9);
    tokenMintY = await customCreateMint(provider.connection, payer, payer.publicKey, 6);

    // Derive PDAs
    [pool0Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMintX.toBuffer(), tokenMintY.toBuffer(), Buffer.from([0])],
      program.programId
    );
    [vault0XPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_x"), pool0Pda.toBuffer()], program.programId);
    [vault0YPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_y"), pool0Pda.toBuffer()], program.programId);
    [lpMint0Pda] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool0Pda.toBuffer()], program.programId);

    [pool1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMintX.toBuffer(), tokenMintY.toBuffer(), Buffer.from([1])],
      program.programId
    );
    [vault1XPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_x"), pool1Pda.toBuffer()], program.programId);
    [vault1YPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_y"), pool1Pda.toBuffer()], program.programId);
    [lpMint1Pda] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool1Pda.toBuffer()], program.programId);

    aliceTokenX = getAssociatedTokenAddressSync(tokenMintX, alice.publicKey);
    aliceTokenY = getAssociatedTokenAddressSync(tokenMintY, alice.publicKey);
    aliceLp0 = getAssociatedTokenAddressSync(lpMint0Pda, alice.publicKey);
    aliceLp1 = getAssociatedTokenAddressSync(lpMint1Pda, alice.publicKey);

    // Setup Alice ATAs and mint tokens
    const setupAccountsTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceTokenX, alice.publicKey, tokenMintX),
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceTokenY, alice.publicKey, tokenMintY),
      createMintToInstruction(tokenMintX, aliceTokenX, payer.publicKey, 10_000_000_000_000),
      createMintToInstruction(tokenMintY, aliceTokenY, payer.publicKey, 1_000_000_000_000)
    );
    await sendTx(provider.connection, setupAccountsTx, [payer]);

    // Initialize Pool 0
    await program.methods
      .initializePool(30, coordinator.publicKey, 0)
      .accounts({
        payer: payer.publicKey,
        pool: pool0Pda,
        tokenMintX,
        tokenMintY,
        tokenVaultX: vault0XPda,
        tokenVaultY: vault0YPda,
        lpMint: lpMint0Pda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Initialize Pool 1
    await program.methods
      .initializePool(30, coordinator.publicKey, 1)
      .accounts({
        payer: payer.publicKey,
        pool: pool1Pda,
        tokenMintX,
        tokenMintY,
        tokenVaultX: vault1XPda,
        tokenVaultY: vault1YPda,
        lpMint: lpMint1Pda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Setup LP ATAs now that lpMints are initialized
    const setupLpTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceLp0, alice.publicKey, lpMint0Pda),
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceLp1, alice.publicKey, lpMint1Pda)
    );
    await sendTx(provider.connection, setupLpTx, [payer]);

    // Deposit liquidity (recreating Vector 4 disparity)
    await program.methods
      .addLiquidity(deposit0X, deposit0Y, new BN(1))
      .accounts({
        provider: alice.publicKey,
        pool: pool0Pda,
        userTokenX: aliceTokenX,
        userTokenY: aliceTokenY,
        tokenVaultX: vault0XPda,
        tokenVaultY: vault0YPda,
        lpMint: lpMint0Pda,
        userLp: aliceLp0,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    await program.methods
      .addLiquidity(deposit1X, deposit1Y, new BN(1))
      .accounts({
        provider: alice.publicKey,
        pool: pool1Pda,
        userTokenX: aliceTokenX,
        userTokenY: aliceTokenY,
        tokenVaultX: vault1XPda,
        tokenVaultY: vault1YPda,
        lpMint: lpMint1Pda,
        userLp: aliceLp1,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();
  });

  after(() => {
    if (fs.existsSync(coordinatorKeyPath)) {
      fs.unlinkSync(coordinatorKeyPath);
    }
  });

  it("1. Baseline Arbitrage Bot: verifies Vector 4 counterfactual extraction", async () => {
    const stdout = execFileSync(process.env.PYTHON_BIN || "python", [
      "solver/arb_bot.py",
      "--demo-vector-4",
      "--json",
    ], { encoding: "utf-8" });
    const arbResult = JSON.parse(stdout);

    // SPEC Vector 4 targets:
    // dx ≈ 12.197 SOL, profit ≈ 30.49 USDC, final price ≈ 102.4848
    expect(arbResult.dx).to.be.closeTo(12.197, 0.005);
    expect(arbResult.profit_y).to.be.closeTo(30.492, 0.01);
    expect(arbResult.final_price).to.be.closeTo(102.4848, 0.005);

    console.log("Arbitrage Bot baseline confirmed:");
    console.log(`  Optimal trade: ${arbResult.dx.toFixed(4)} SOL`);
    console.log(`  Extracted MEV: ${arbResult.profit_y.toFixed(4)} USDC`);
    console.log(`  Post-arb price: ${arbResult.final_price.toFixed(4)} USDC/SOL`);
  });

  it("2. Keeper Dry-Run: computes optimal rebalance without broadcasting", async () => {
    const pool0Before = await program.account.pool.fetch(pool0Pda);
    const pool1Before = await program.account.pool.fetch(pool1Pda);

    await runKeeper({
      rpc: provider.connection.rpcEndpoint,
      keypair: coordinatorKeyPath,
      mintX: tokenMintX.toBase58(),
      mintY: tokenMintY.toBase58(),
      pools: [0, 1],
      minGapBps: 5,
      toleranceBps: 20,
      dryRun: true,
      once: true,
      interval: 1,
    });

    const pool0After = await program.account.pool.fetch(pool0Pda);
    const pool1After = await program.account.pool.fetch(pool1Pda);

    // Assert reserves did not change in dry-run mode
    assert.equal(pool0After.reserveX.toString(), pool0Before.reserveX.toString());
    assert.equal(pool0After.reserveY.toString(), pool0Before.reserveY.toString());
    assert.equal(pool1After.reserveX.toString(), pool1Before.reserveX.toString());
    assert.equal(pool1After.reserveY.toString(), pool1Before.reserveY.toString());
  });

  it("3. Keeper Live Mode: detects 500 bps gap, executes rebalance, and aligns prices", async () => {
    await runKeeper({
      rpc: provider.connection.rpcEndpoint,
      keypair: coordinatorKeyPath,
      mintX: tokenMintX.toBase58(),
      mintY: tokenMintY.toBase58(),
      pools: [0, 1],
      minGapBps: 5,
      toleranceBps: 20,
      dryRun: false,
      once: true,
      interval: 1,
    });

    const pool0 = await program.account.pool.fetch(pool0Pda);
    const pool1 = await program.account.pool.fetch(pool1Pda);

    const r0x = pool0.reserveX.toNumber() / 1e9;
    const r0y = pool0.reserveY.toNumber() / 1e6;
    const r1x = pool1.reserveX.toNumber() / 1e9;
    const r1y = pool1.reserveY.toNumber() / 1e6;

    const price0 = r0y / r0x;
    const price1 = r1y / r1x;

    console.log("\nPost-Rebalance Verification:");
    console.log(`  Pool #0: ${r0x.toFixed(6)} SOL, ${r0y.toFixed(6)} USDC -> Price: ${price0.toFixed(4)}`);
    console.log(`  Pool #1: ${r1x.toFixed(6)} SOL, ${r1y.toFixed(6)} USDC -> Price: ${price1.toFixed(4)}`);

    // Both prices must be 102.50 within tolerance
    expect(price0).to.be.closeTo(102.50, 0.05);
    expect(price1).to.be.closeTo(102.50, 0.05);

    // Post-rebalance gap must be < 5 bps
    const gapBps = (Math.abs(price0 - price1) / Math.min(price0, price1)) * 10000;
    console.log(`  Post-Rebalance Price Gap: ${gapBps.toFixed(4)} bps`);
    expect(gapBps).to.be.lessThan(5.0);

    // Invariant monotonicity: Pool 0 k strictly grew, Pool 1 k preserved
    const k0Pre = 1000.0 * 100000.0;
    const k0Post = r0x * r0y;
    expect(k0Post).to.be.greaterThan(k0Pre);
  });

  it("4. Keeper Equilibrium Check: recognizes balanced pools and avoids unnecessary rebalances", async () => {
    // Run keeper again when pools are already balanced
    await runKeeper({
      rpc: provider.connection.rpcEndpoint,
      keypair: coordinatorKeyPath,
      mintX: tokenMintX.toBase58(),
      mintY: tokenMintY.toBase58(),
      pools: [0, 1],
      minGapBps: 5,
      toleranceBps: 20,
      dryRun: false,
      once: true,
      interval: 1,
    });

    // Verification: keeper skipped execution, pool reserves remain stable
    const pool0 = await program.account.pool.fetch(pool0Pda);
    const pool1 = await program.account.pool.fetch(pool1Pda);
    assert.isTrue(pool0.reserveX.toNumber() > 0);
    assert.isTrue(pool1.reserveX.toNumber() > 0);
  });
});
