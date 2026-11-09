import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PoolSync } from "../target/types/pool_sync";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert, expect } from "chai";
import BN from "bn.js";

describe("PoolSync Phase 2: Multi-Pool Atomic Rebalance", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(envProvider.connection, envProvider.wallet, { commitment: "processed", preflightCommitment: "processed" });
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
      await new Promise((r) => setTimeout(r, 200));
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

  // Test mints: X (SOL, 9 decimals) and Y (USDC, 6 decimals)
  let tokenMintX: PublicKey;
  let tokenMintY: PublicKey;

  // Pool A (index: 0, initial price 100: 1,000 SOL / 100,000 USDC)
  let poolAPda: PublicKey;
  let vaultAXPda: PublicKey;
  let vaultAYPda: PublicKey;
  let lpMintAPda: PublicKey;

  // Pool B (index: 1, initial price 105: 1,000 SOL / 105,000 USDC)
  let poolBPda: PublicKey;
  let vaultBXPda: PublicKey;
  let vaultBYPda: PublicKey;
  let lpMintBPda: PublicKey;

  const coordinator = Keypair.generate();
  const alice = Keypair.generate();
  let aliceTokenX: PublicKey;
  let aliceTokenY: PublicKey;
  let aliceLpA: PublicKey;
  let aliceLpB: PublicKey;

  // Vector 4 values:
  // Pool A = 1,000 SOL (10^9) and 100,000 USDC (10^6)
  const depositAX = new BN(1_000_000_000_000); // 1,000 * 10^9
  const depositAY = new BN(100_000_000_000);   // 100,000 * 10^6

  // Pool B = 1,000 SOL (10^9) and 105,000 USDC (10^6)
  const depositBX = new BN(1_000_000_000_000); // 1,000 * 10^9
  const depositBY = new BN(105_000_000_000);   // 105,000 * 10^6

  // Vector 4 rebalance transfers:
  // Transfer A -> B: 12.121703 SOL = 12_121_703_000 lamports
  // Transfer B -> A: 1,257.530000 USDC = 1_257_530_000 micro-USDC
  const transferAmountX = new BN(12_121_703_000);
  const transferAmountY = new BN(1_257_530_000);

  before(async () => {

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

    // Create token mints X (9 decimals) and Y (6 decimals)
    tokenMintX = await customCreateMint(provider.connection, payer, payer.publicKey, 9);
    tokenMintY = await customCreateMint(provider.connection, payer, payer.publicKey, 6);

    // Derive PDAs for Pool A (index: 0)
    [poolAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMintX.toBuffer(), tokenMintY.toBuffer(), Buffer.from([0])],
      program.programId
    );
    [vaultAXPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_x"), poolAPda.toBuffer()],
      program.programId
    );
    [vaultAYPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_y"), poolAPda.toBuffer()],
      program.programId
    );
    [lpMintAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), poolAPda.toBuffer()],
      program.programId
    );

    // Derive PDAs for Pool B (index: 1)
    [poolBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMintX.toBuffer(), tokenMintY.toBuffer(), Buffer.from([1])],
      program.programId
    );
    [vaultBXPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_x"), poolBPda.toBuffer()],
      program.programId
    );
    [vaultBYPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_y"), poolBPda.toBuffer()],
      program.programId
    );
    [lpMintBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), poolBPda.toBuffer()],
      program.programId
    );

    aliceTokenX = getAssociatedTokenAddressSync(tokenMintX, alice.publicKey);
    aliceTokenY = getAssociatedTokenAddressSync(tokenMintY, alice.publicKey);
    aliceLpA = getAssociatedTokenAddressSync(lpMintAPda, alice.publicKey);
    aliceLpB = getAssociatedTokenAddressSync(lpMintBPda, alice.publicKey);

    // Setup token accounts for Alice and mint sufficient tokens
    const setupAccountsTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceTokenX, alice.publicKey, tokenMintX),
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceTokenY, alice.publicKey, tokenMintY),
      createMintToInstruction(tokenMintX, aliceTokenX, payer.publicKey, 10_000_000_000_000), // 10,000 SOL
      createMintToInstruction(tokenMintY, aliceTokenY, payer.publicKey, 1_000_000_000_000)   // 1,000,000 USDC
    );
    await sendTx(provider.connection, setupAccountsTx, [payer]);

    // Initialize Pool A (index: 0, fee: 30 bps, coordinator)
    await program.methods
      .initializePool(30, coordinator.publicKey, 0)
      .accounts({
        payer: payer.publicKey,
        pool: poolAPda,
        tokenMintX,
        tokenMintY,
        tokenVaultX: vaultAXPda,
        tokenVaultY: vaultAYPda,
        lpMint: lpMintAPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Initialize Pool B (index: 1, fee: 30 bps, coordinator)
    await program.methods
      .initializePool(30, coordinator.publicKey, 1)
      .accounts({
        payer: payer.publicKey,
        pool: poolBPda,
        tokenMintX,
        tokenMintY,
        tokenVaultX: vaultBXPda,
        tokenVaultY: vaultBYPda,
        lpMint: lpMintBPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Create Alice's LP token accounts now that lpMints are initialized
    const setupLpTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceLpA, alice.publicKey, lpMintAPda),
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceLpB, alice.publicKey, lpMintBPda)
    );
    await sendTx(provider.connection, setupLpTx, [payer]);

    // Seed Pool A with 1,000 SOL and 100,000 USDC
    await program.methods
      .addLiquidity(depositAX, depositAY, new BN(1))
      .accounts({
        provider: alice.publicKey,
        pool: poolAPda,
        userTokenX: aliceTokenX,
        userTokenY: aliceTokenY,
        tokenVaultX: vaultAXPda,
        tokenVaultY: vaultAYPda,
        lpMint: lpMintAPda,
        userLp: aliceLpA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    // Seed Pool B with 1,000 SOL and 105,000 USDC
    await program.methods
      .addLiquidity(depositBX, depositBY, new BN(1))
      .accounts({
        provider: alice.publicKey,
        pool: poolBPda,
        userTokenX: aliceTokenX,
        userTokenY: aliceTokenY,
        tokenVaultX: vaultBXPda,
        tokenVaultY: vaultBYPda,
        lpMint: lpMintBPda,
        userLp: aliceLpB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();
  });

  it("1. Positive Test: SPEC Test Vector 4 On-Chain Atomic Rebalance", async () => {
    const poolABefore = await program.account.pool.fetch(poolAPda);
    const poolBBefore = await program.account.pool.fetch(poolBPda);

    assert.equal(poolABefore.reserveX.toString(), depositAX.toString());
    assert.equal(poolABefore.reserveY.toString(), depositAY.toString());
    assert.equal(poolBBefore.reserveX.toString(), depositBX.toString());
    assert.equal(poolBBefore.reserveY.toString(), depositBY.toString());

    // Transfers:
    // Transfer 1: Pool A (index 0) -> Pool B (index 1), token X (12.121703 SOL)
    // Transfer 2: Pool B (index 1) -> Pool A (index 0), token Y (1,257.530000 USDC)
    const transfers = [
      {
        fromPool: 0,
        toPool: 1,
        isTokenX: true,
        amount: transferAmountX,
      },
      {
        fromPool: 1,
        toPool: 0,
        isTokenX: false,
        amount: transferAmountY,
      },
    ];

    const expectedReserves = [
      {
        reserveX: poolABefore.reserveX,
        reserveY: poolABefore.reserveY,
      },
      {
        reserveX: poolBBefore.reserveX,
        reserveY: poolBBefore.reserveY,
      },
    ];

    // Remaining accounts order for rebalance:
    // Pool 0: [poolAPda, vaultAXPda, vaultAYPda]
    // Pool 1: [poolBPda, vaultBXPda, vaultBYPda]
    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    // Listen for RebalanceEvent
    let emittedEvent: any = null;
    const listener = program.addEventListener("rebalanceEvent", (event) => {
      emittedEvent = event;
    });

    const txSig = await program.methods
      .rebalance(transfers, expectedReserves, 20)
      .accounts({
        coordinator: coordinator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .signers([coordinator])
      .rpc();

    // Give listener time to capture event
    await new Promise((r) => setTimeout(r, 600));
    program.removeEventListener(listener);

    const poolAAfter = await program.account.pool.fetch(poolAPda);
    const poolBAfter = await program.account.pool.fetch(poolBPda);

    // Verify post-reserves
    // Pool A: 1000 - 12.121703 = 987.878297 SOL; 100,000 + 1,257.530 = 101,257.530 USDC
    const expectedPostAX = depositAX.sub(transferAmountX);
    const expectedPostAY = depositAY.add(transferAmountY);
    assert.equal(poolAAfter.reserveX.toString(), expectedPostAX.toString());
    assert.equal(poolAAfter.reserveY.toString(), expectedPostAY.toString());

    // Pool B: 1000 + 12.121703 = 1012.121703 SOL; 105,000 - 1,257.530 = 103,742.470 USDC
    const expectedPostBX = depositBX.add(transferAmountX);
    const expectedPostBY = depositBY.sub(transferAmountY);
    assert.equal(poolBAfter.reserveX.toString(), expectedPostBX.toString());
    assert.equal(poolBAfter.reserveY.toString(), expectedPostBY.toString());

    // Verify token conservation across vaults
    const vaultAXAcc = await getAccount(provider.connection, vaultAXPda);
    const vaultAYAcc = await getAccount(provider.connection, vaultAYPda);
    const vaultBXAcc = await getAccount(provider.connection, vaultBXPda);
    const vaultBYAcc = await getAccount(provider.connection, vaultBYPda);

    assert.equal(vaultAXAcc.amount.toString(), expectedPostAX.toString());
    assert.equal(vaultAYAcc.amount.toString(), expectedPostAY.toString());
    assert.equal(vaultBXAcc.amount.toString(), expectedPostBX.toString());
    assert.equal(vaultBYAcc.amount.toString(), expectedPostBY.toString());

    // Verify both pools converged to common price 102.50 within tolerance
    // Spot price pA = (101257.53 / 987.878297) = 102.50000003
    // Spot price pB = (103742.47 / 1012.121703) = 102.49999980
    const priceA = poolAAfter.reserveY.toNumber() * 1e3 / poolAAfter.reserveX.toNumber();
    const priceB = poolBAfter.reserveY.toNumber() * 1e3 / poolBAfter.reserveX.toNumber();
    expect(Math.abs(priceA - 102.50)).to.be.lessThan(0.01);
    expect(Math.abs(priceB - 102.50)).to.be.lessThan(0.01);
    expect(Math.abs(priceA - priceB)).to.be.lessThan(0.001);

    // Verify k-monotonicity
    // Pool A k strictly increased
    expect(new BN(poolAAfter.kLast.toString()).gt(new BN(poolABefore.kLast.toString()))).to.be.true;
    // Pool B k is preserved (k_new >= k_old)
    expect(new BN(poolBAfter.kLast.toString()).gte(new BN(poolBBefore.kLast.toString()))).to.be.true;

    // Verify emitted event
    if (emittedEvent) {
      assert.equal(emittedEvent.coordinator.toBase58(), coordinator.publicKey.toBase58());
      assert.equal(emittedEvent.poolCount, 2);
      // Counterfactual arb profit should be ~30.49 USDC (30_490_000 micro-USDC)
      const arbProfit = new BN(emittedEvent.counterfactualArbProfitY.toString());
      console.log("Captured RebalanceEvent counterfactual arb profit (micro-USDC):", arbProfit.toString());
      expect(arbProfit.toNumber()).to.be.greaterThan(25_000_000);
      expect(arbProfit.toNumber()).to.be.lessThan(35_000_000);
    }
  });

  it("2. Negative Test: Check 2 rejects Stale Reserves", async () => {
    const poolA = await program.account.pool.fetch(poolAPda);
    const poolB = await program.account.pool.fetch(poolBPda);

    // Provide deliberately stale/incorrect reserves for Pool A
    const staleExpectedReserves = [
      {
        reserveX: poolA.reserveX.sub(new BN(100)), // Mismatch!
        reserveY: poolA.reserveY,
      },
      {
        reserveX: poolB.reserveX,
        reserveY: poolB.reserveY,
      },
    ];

    const transfers = [
      { fromPool: 0, toPool: 1, isTokenX: true, amount: new BN(100) },
      { fromPool: 1, toPool: 0, isTokenX: true, amount: new BN(100) },
    ];

    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    try {
      await program.methods
        .rebalance(transfers, staleExpectedReserves, 20)
        .accounts({
          coordinator: coordinator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([coordinator])
        .rpc();
      assert.fail("Should have failed with StaleReserves");
    } catch (err: any) {
      assert.include(err.toString(), "StaleReserves");
    }
  });

  it("3. Negative Test: Check 1 rejects Unauthorized Coordinator", async () => {
    const poolA = await program.account.pool.fetch(poolAPda);
    const poolB = await program.account.pool.fetch(poolBPda);

    const imposter = Keypair.generate();
    // Fund imposter
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: imposter.publicKey,
        lamports: 1 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    await sendTx(provider.connection, fundTx, [payer]);

    const expectedReserves = [
      { reserveX: poolA.reserveX, reserveY: poolA.reserveY },
      { reserveX: poolB.reserveX, reserveY: poolB.reserveY },
    ];

    const transfers = [
      { fromPool: 0, toPool: 1, isTokenX: true, amount: new BN(100) },
      { fromPool: 1, toPool: 0, isTokenX: true, amount: new BN(100) },
    ];

    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    try {
      await program.methods
        .rebalance(transfers, expectedReserves, 20)
        .accounts({
          coordinator: imposter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([imposter])
        .rpc();
      assert.fail("Should have failed with UnauthorizedCoordinator");
    } catch (err: any) {
      assert.include(err.toString(), "UnauthorizedCoordinator");
    }
  });

  it("4. Negative Test: Check 1 rejects Vetoed / Opted-Out Pool", async () => {
    const poolA = await program.account.pool.fetch(poolAPda);
    const poolB = await program.account.pool.fetch(poolBPda);

    // Update policy of Pool B to opt_in = false
    const optedOutPolicy = {
      optIn: false,
      coordinator: coordinator.publicKey,
      minReserveX: new BN(0),
      minReserveY: new BN(0),
      maxTransferBps: 10_000,
      maxStalenessSlots: new BN(150),
      minKGain: new BN(0),
      paused: false,
    };

    await program.methods
      .setPolicy(optedOutPolicy)
      .accounts({
        authority: coordinator.publicKey,
        pool: poolBPda,
      })
      .signers([coordinator])
      .rpc();

    const expectedReserves = [
      { reserveX: poolA.reserveX, reserveY: poolA.reserveY },
      { reserveX: poolB.reserveX, reserveY: poolB.reserveY },
    ];

    const transfers = [
      { fromPool: 0, toPool: 1, isTokenX: true, amount: new BN(100) },
      { fromPool: 1, toPool: 0, isTokenX: true, amount: new BN(100) },
    ];

    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    try {
      await program.methods
        .rebalance(transfers, expectedReserves, 20)
        .accounts({
          coordinator: coordinator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([coordinator])
        .rpc();
      assert.fail("Should have failed with PoolNotOptedIn");
    } catch (err: any) {
      assert.include(err.toString(), "PoolNotOptedIn");
    } finally {
      // Revert policy to opt_in = true
      optedOutPolicy.optIn = true;
      await program.methods
        .setPolicy(optedOutPolicy)
        .accounts({
          authority: coordinator.publicKey,
          pool: poolBPda,
        })
        .signers([coordinator])
        .rpc();
    }
  });

  it("5. Negative Test: Check 3 rejects Broken Token Conservation", async () => {
    const poolA = await program.account.pool.fetch(poolAPda);
    const poolB = await program.account.pool.fetch(poolBPda);

    const expectedReserves = [
      { reserveX: poolA.reserveX, reserveY: poolA.reserveY },
      { reserveX: poolB.reserveX, reserveY: poolB.reserveY },
    ];

    // Attempt transfer targeting an external pool index outside opted-in pools (breaks Check 3 conservation)
    const transfers = [
      { fromPool: 0, toPool: 99, isTokenX: true, amount: new BN(1000) },
    ];

    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    try {
      await program.methods
        .rebalance(transfers, expectedReserves, 20)
        .accounts({
          coordinator: coordinator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([coordinator])
        .rpc();
      assert.fail("Should have failed with ConservationViolation");
    } catch (err: any) {
      assert.include(err.toString(), "ConservationViolation");
    }
  });

  it("6. Negative Test: Check 4 rejects k invariant decrease", async () => {
    const poolA = await program.account.pool.fetch(poolAPda);
    const poolB = await program.account.pool.fetch(poolBPda);

    const expectedReserves = [
      { reserveX: poolA.reserveX, reserveY: poolA.reserveY },
      { reserveX: poolB.reserveX, reserveY: poolB.reserveY },
    ];

    // Transfer token X out of Pool A without giving it sufficient token Y,
    // causing Pool A's k to decrease!
    // Transfer 100 SOL from A to B, but only give A 1 USDC from B:
    const transfers = [
      { fromPool: 0, toPool: 1, isTokenX: true, amount: new BN(100_000_000_000) }, // 100 SOL
      { fromPool: 1, toPool: 0, isTokenX: false, amount: new BN(1) },             // 0.000001 USDC
    ];

    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    try {
      await program.methods
        .rebalance(transfers, expectedReserves, 100)
        .accounts({
          coordinator: coordinator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([coordinator])
        .rpc();
      assert.fail("Should have failed with KDecreased");
    } catch (err: any) {
      assert.include(err.toString(), "KDecreased");
    }
  });

  it("7. Negative Test: Check 5 rejects Paused Pool", async () => {
    const poolA = await program.account.pool.fetch(poolAPda);
    const poolB = await program.account.pool.fetch(poolBPda);

    // Pause Pool A
    await program.methods
      .pause(true)
      .accounts({
        authority: coordinator.publicKey,
        pool: poolAPda,
      })
      .signers([coordinator])
      .rpc();

    const expectedReserves = [
      { reserveX: poolA.reserveX, reserveY: poolA.reserveY },
      { reserveX: poolB.reserveX, reserveY: poolB.reserveY },
    ];

    const transfers = [
      { fromPool: 0, toPool: 1, isTokenX: true, amount: new BN(100) },
      { fromPool: 1, toPool: 0, isTokenX: true, amount: new BN(100) },
    ];

    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    try {
      await program.methods
        .rebalance(transfers, expectedReserves, 20)
        .accounts({
          coordinator: coordinator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([coordinator])
        .rpc();
      assert.fail("Should have failed with PoolPaused");
    } catch (err: any) {
      assert.include(err.toString(), "PoolPaused");
    } finally {
      // Unpause Pool A
      await program.methods
        .pause(false)
        .accounts({
          authority: coordinator.publicKey,
          pool: poolAPda,
        })
        .signers([coordinator])
        .rpc();
    }
  });

  it("8. Negative Test: Check 6 rejects Non-Arbitrage-Free result (tolerance exceeded)", async () => {
    // 1. Execute a swap on Pool A to create an intentional price divergence between Pool A and Pool B
    // Swap 50 SOL for USDC on Pool A
    const swapAmountX = new BN(50_000_000_000); // 50 SOL
    await program.methods
      .swap(swapAmountX, new BN(1), true)
      .accounts({
        user: alice.publicKey,
        pool: poolAPda,
        userTokenX: aliceTokenX,
        userTokenY: aliceTokenY,
        tokenVaultX: vaultAXPda,
        tokenVaultY: vaultAYPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const poolA = await program.account.pool.fetch(poolAPda);
    const poolB = await program.account.pool.fetch(poolBPda);

    // Verify prices have diverged (>200 bps apart)
    const priceA = poolA.reserveY.toNumber() * 1e3 / poolA.reserveX.toNumber();
    const priceB = poolB.reserveY.toNumber() * 1e3 / poolB.reserveX.toNumber();
    expect(Math.abs(priceA - priceB) / priceB).to.be.greaterThan(0.02); // >2% difference

    const expectedReserves = [
      { reserveX: poolA.reserveX, reserveY: poolA.reserveY },
      { reserveX: poolB.reserveX, reserveY: poolB.reserveY },
    ];

    // Submit minimal transfers that conserve tokens and don't equalize prices (divergence remains ~1000 bps)
    const transfers = [
      { fromPool: 0, toPool: 1, isTokenX: true, amount: new BN(1_000) },
      { fromPool: 1, toPool: 0, isTokenX: true, amount: new BN(1_000) },
    ];

    const remainingAccounts = [
      { pubkey: poolAPda, isWritable: true, isSigner: false },
      { pubkey: vaultAXPda, isWritable: true, isSigner: false },
      { pubkey: vaultAYPda, isWritable: true, isSigner: false },
      { pubkey: poolBPda, isWritable: true, isSigner: false },
      { pubkey: vaultBXPda, isWritable: true, isSigner: false },
      { pubkey: vaultBYPda, isWritable: true, isSigner: false },
    ];

    // Attempt rebalance with standard 20 bps tolerance; should fail Check 6
    try {
      await program.methods
        .rebalance(transfers, expectedReserves, 20)
        .accounts({
          coordinator: coordinator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([coordinator])
        .rpc();
      assert.fail("Should have failed with NotArbitrageFree");
    } catch (err: any) {
      assert.include(err.toString(), "NotArbitrageFree");
    }
  });
});
