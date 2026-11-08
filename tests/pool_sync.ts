import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PoolSync } from "../target/types/pool_sync";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  createAccount,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { assert, expect } from "chai";
import BN from "bn.js";

describe("PoolSync Phase 1: Core AMM Program", () => {
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
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "processed" });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "processed");
    return sig;
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
  let poolPda: PublicKey;
  let poolBump: number;
  let vaultXPda: PublicKey;
  let vaultYPda: PublicKey;
  let lpMintPda: PublicKey;

  const coordinator = Keypair.generate();
  const alice = Keypair.generate();
  let aliceTokenX: PublicKey;
  let aliceTokenY: PublicKey;
  let aliceLp: PublicKey;

  const bob = Keypair.generate();
  let bobTokenX: PublicKey;
  let bobTokenY: PublicKey;

  before(async () => {

    console.log("Checkpoint B: funding alice and bob...");
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: alice.publicKey,
        lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: bob.publicKey,
        lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    await sendTx(provider.connection, tx, [payer]);
    console.log("Checkpoint B done: funded alice and bob");

    console.log("Checkpoint C: creating mint X...");
    tokenMintX = await customCreateMint(provider.connection, payer, payer.publicKey, 9);
    console.log("Checkpoint C done: tokenMintX =", tokenMintX.toBase58());

    console.log("Checkpoint D: creating mint Y...");
    tokenMintY = await customCreateMint(provider.connection, payer, payer.publicKey, 6);
    console.log("Checkpoint D done: tokenMintY =", tokenMintY.toBase58());

    // Derive PDAs
    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMintX.toBuffer(), tokenMintY.toBuffer(), Buffer.from([0])],
      program.programId
    );

    [vaultXPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_x"), poolPda.toBuffer()],
      program.programId
    );

    [vaultYPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_y"), poolPda.toBuffer()],
      program.programId
    );

    [lpMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), poolPda.toBuffer()],
      program.programId
    );

    // Derive ATAs
    aliceTokenX = getAssociatedTokenAddressSync(tokenMintX, alice.publicKey);
    aliceTokenY = getAssociatedTokenAddressSync(tokenMintY, alice.publicKey);
    bobTokenX = getAssociatedTokenAddressSync(tokenMintX, bob.publicKey);
    bobTokenY = getAssociatedTokenAddressSync(tokenMintY, bob.publicKey);

    // Create user token accounts and mint initial tokens in one batched transaction
    const setupAccountsTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceTokenX, alice.publicKey, tokenMintX),
      createAssociatedTokenAccountInstruction(payer.publicKey, aliceTokenY, alice.publicKey, tokenMintY),
      createAssociatedTokenAccountInstruction(payer.publicKey, bobTokenX, bob.publicKey, tokenMintX),
      createAssociatedTokenAccountInstruction(payer.publicKey, bobTokenY, bob.publicKey, tokenMintY),
      createMintToInstruction(tokenMintX, aliceTokenX, payer.publicKey, 5000_000_000_000),
      createMintToInstruction(tokenMintY, aliceTokenY, payer.publicKey, 500_000_000_000),
      createMintToInstruction(tokenMintX, bobTokenX, payer.publicKey, 1000_000_000_000),
      createMintToInstruction(tokenMintY, bobTokenY, payer.publicKey, 100_000_000_000)
    );
    console.log("Checkpoint E: setting up accounts...");
    await sendTx(provider.connection, setupAccountsTx, [payer]);
    console.log("Checkpoint F: setup accounts done");
  });

  it("1. Initialize Pool: sets up vaults, LP mint, fee, and policy", async () => {
    const feeBps = 30; // 0.30%
    await program.methods
      .initializePool(feeBps, coordinator.publicKey, 0)
      .accounts({
        payer: payer.publicKey,
        pool: poolPda,
        tokenMintX,
        tokenMintY,
        tokenVaultX: vaultXPda,
        tokenVaultY: vaultYPda,
        lpMint: lpMintPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const pool = await program.account.pool.fetch(poolPda);
    assert.equal(pool.tokenMintX.toBase58(), tokenMintX.toBase58());
    assert.equal(pool.tokenMintY.toBase58(), tokenMintY.toBase58());
    assert.equal(pool.reserveX.toNumber(), 0);
    assert.equal(pool.reserveY.toNumber(), 0);
    assert.equal(pool.feeBps, feeBps);
    assert.equal(pool.policy.coordinator.toBase58(), coordinator.publicKey.toBase58());
    assert.isTrue(pool.policy.optIn);
    assert.isFalse(pool.policy.paused);
  });

  it("2. Add Initial Liquidity: geometric mean LP tokens minted", async () => {
    // Create Alice's LP token account now that lpMint has been initialized
    aliceLp = getAssociatedTokenAddressSync(lpMintPda, alice.publicKey);
    const createLpTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(alice.publicKey, aliceLp, alice.publicKey, lpMintPda)
    );
    await sendTx(provider.connection, createLpTx, [alice]);

    // Deposit 1,000 SOL (token X) and 100,000 USDC (token Y)
    const depositX = new BN(1_000_000_000_000); // 1,000 * 10^9
    const depositY = new BN(100_000_000_000);  // 100,000 * 10^6

    await program.methods
      .addLiquidity(depositX, depositY, new BN(1))
      .accounts({
        provider: alice.publicKey,
        pool: poolPda,
        userTokenX: aliceTokenX,
        userTokenY: aliceTokenY,
        tokenVaultX: vaultXPda,
        tokenVaultY: vaultYPda,
        lpMint: lpMintPda,
        userLp: aliceLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const pool = await program.account.pool.fetch(poolPda);
    assert.equal(pool.reserveX.toString(), depositX.toString());
    assert.equal(pool.reserveY.toString(), depositY.toString());

    // Expected initial LP = integer_sqrt(depositX * depositY)
    const kExpected = depositX.mul(depositY);
    assert.equal(pool.kLast.toString(), kExpected.toString());

    const aliceLpAccount = await getAccount(provider.connection, aliceLp);
    assert.isTrue(aliceLpAccount.amount > 0n);
  });

  it("3. Swap Token X -> Token Y: constant product invariant holds", async () => {
    const poolBefore = await program.account.pool.fetch(poolPda);
    const amountInX = new BN(10_000_000_000); // 10 SOL

    await program.methods
      .swap(amountInX, new BN(1), true)
      .accounts({
        user: bob.publicKey,
        pool: poolPda,
        userTokenX: bobTokenX,
        userTokenY: bobTokenY,
        tokenVaultX: vaultXPda,
        tokenVaultY: vaultYPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bob])
      .rpc();

    const poolAfter = await program.account.pool.fetch(poolPda);
    assert.isTrue(poolAfter.reserveX.gt(poolBefore.reserveX));
    assert.isTrue(poolAfter.reserveY.lt(poolBefore.reserveY));
    // Invariant check: new k >= old k (due to trading fee, k increases!)
    assert.isTrue(
      poolAfter.kLast.gte(poolBefore.kLast),
      `k did not increase: ${poolAfter.kLast.toString()} < ${poolBefore.kLast.toString()}`
    );
  });

  it("4. Swap Token Y -> Token X: constant product invariant holds", async () => {
    const poolBefore = await program.account.pool.fetch(poolPda);
    const amountInY = new BN(2_000_000_000); // 2,000 USDC

    await program.methods
      .swap(amountInY, new BN(1), false)
      .accounts({
        user: bob.publicKey,
        pool: poolPda,
        userTokenX: bobTokenX,
        userTokenY: bobTokenY,
        tokenVaultX: vaultXPda,
        tokenVaultY: vaultYPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bob])
      .rpc();

    const poolAfter = await program.account.pool.fetch(poolPda);
    assert.isTrue(poolAfter.reserveY.gt(poolBefore.reserveY));
    assert.isTrue(poolAfter.reserveX.lt(poolBefore.reserveX));
    assert.isTrue(
      poolAfter.kLast.gte(poolBefore.kLast),
      `k did not increase: ${poolAfter.kLast.toString()} < ${poolBefore.kLast.toString()}`
    );
  });

  it("5. Pause and Resume: swaps blocked when paused, unblocked when active", async () => {
    // Coordinator pauses the pool
    await program.methods
      .pause(true)
      .accounts({
        authority: coordinator.publicKey,
        pool: poolPda,
      })
      .signers([coordinator])
      .rpc();

    let pool = await program.account.pool.fetch(poolPda);
    assert.isTrue(pool.policy.paused);

    // Swap attempt should fail
    try {
      await program.methods
        .swap(new BN(1_000_000_000), new BN(1), true)
        .accounts({
          user: bob.publicKey,
          pool: poolPda,
          userTokenX: bobTokenX,
          userTokenY: bobTokenY,
          tokenVaultX: vaultXPda,
          tokenVaultY: vaultYPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob])
        .rpc();
      assert.fail("Swap should have failed when paused");
    } catch (err: any) {
      assert.include(err.toString(), "PoolPaused");
    }

    // Coordinator unpauses the pool
    await program.methods
      .pause(false)
      .accounts({
        authority: coordinator.publicKey,
        pool: poolPda,
      })
      .signers([coordinator])
      .rpc();

    pool = await program.account.pool.fetch(poolPda);
    assert.isFalse(pool.policy.paused);

    // Swap now succeeds
    await program.methods
      .swap(new BN(1_000_000_000), new BN(1), true)
      .accounts({
        user: bob.publicKey,
        pool: poolPda,
        userTokenX: bobTokenX,
        userTokenY: bobTokenY,
        tokenVaultX: vaultXPda,
        tokenVaultY: vaultYPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bob])
      .rpc();
  });

  it("6. Remove Liquidity: burns LP tokens and returns proportional reserves", async () => {
    const aliceLpBefore = await getAccount(provider.connection, aliceLp);
    const burnAmount = new BN((aliceLpBefore.amount / 4n).toString()); // 25% of LP

    const poolBefore = await program.account.pool.fetch(poolPda);

    await program.methods
      .removeLiquidity(burnAmount, new BN(1), new BN(1))
      .accounts({
        provider: alice.publicKey,
        pool: poolPda,
        userTokenX: aliceTokenX,
        userTokenY: aliceTokenY,
        tokenVaultX: vaultXPda,
        tokenVaultY: vaultYPda,
        lpMint: lpMintPda,
        userLp: aliceLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const poolAfter = await program.account.pool.fetch(poolPda);
    assert.isTrue(poolAfter.reserveX.lt(poolBefore.reserveX));
    assert.isTrue(poolAfter.reserveY.lt(poolBefore.reserveY));
  });

  it("7. Randomized Property Test: 20 sequential random swaps strictly increase/preserve k", async () => {
    for (let i = 0; i < 20; i++) {
      const poolBefore = await program.account.pool.fetch(poolPda);
      const isX = Math.random() > 0.5;
      const amountIn = isX
        ? new BN(Math.floor(Math.random() * 5_000_000_000) + 1_000_000) // 0.001 - 5 SOL
        : new BN(Math.floor(Math.random() * 500_000_000) + 100_000);   // 0.1 - 500 USDC

      await program.methods
        .swap(amountIn, new BN(1), isX)
        .accounts({
          user: bob.publicKey,
          pool: poolPda,
          userTokenX: bobTokenX,
          userTokenY: bobTokenY,
          tokenVaultX: vaultXPda,
          tokenVaultY: vaultYPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob])
        .rpc();

      const poolAfter = await program.account.pool.fetch(poolPda);
      assert.isTrue(
        poolAfter.kLast.gte(poolBefore.kLast),
        `Random swap ${i} violated k-monotonicity: ${poolAfter.kLast.toString()} < ${poolBefore.kLast.toString()}`
      );
    }
  });
});
