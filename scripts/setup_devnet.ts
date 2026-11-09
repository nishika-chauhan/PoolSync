import { fileURLToPath } from "url";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { PoolSync } from "../target/types/pool_sync";
import idl from "../target/idl/pool_sync.json";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";

async function main() {
  console.log("=================================================");
  console.log("       PoolSync Devnet Pools Initialization       ");
  console.log("=================================================");

  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");

  const keysDir = path.join(process.cwd(), "keys");
  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

  const deployerKeyPath = path.join(keysDir, "devnet-deployer.json");
  if (!fs.existsSync(deployerKeyPath)) {
    throw new Error(`Deployer keypair not found at ${deployerKeyPath}. Run scripts/deploy_devnet.sh first.`);
  }

  const deployerSecret = JSON.parse(fs.readFileSync(deployerKeyPath, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  console.log(`Payer / Deployer: ${payer.publicKey.toBase58()}`);

  const coordinatorKeyPath = path.join(keysDir, "coordinator-keypair.json");
  let coordinator: Keypair;
  if (!fs.existsSync(coordinatorKeyPath)) {
    coordinator = Keypair.generate();
    fs.writeFileSync(coordinatorKeyPath, JSON.stringify(Array.from(coordinator.secretKey)));
  } else {
    coordinator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(coordinatorKeyPath, "utf-8"))));
  }
  console.log(`Coordinator:      ${coordinator.publicKey.toBase58()}`);

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program<PoolSync>(idl as any, provider);
  console.log(`PoolSync Program: ${program.programId.toBase58()}`);

  async function sendTx(tx: Transaction, signers: Keypair[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }

  async function customCreateMint(decimals: number): Promise<PublicKey> {
    const mintKey = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(82);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKey.publicKey,
        space: 82,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintKey.publicKey, decimals, payer.publicKey, null, TOKEN_PROGRAM_ID)
    );
    await sendTx(tx, [payer, mintKey]);
    return mintKey.publicKey;
  }

  console.log("\n1. Creating Mock Token Mints...");
  const tokenMintX = await customCreateMint(9); // Mock SOL (9 decimals)
  console.log(`  Mock SOL Mint:  ${tokenMintX.toBase58()}`);
  const tokenMintY = await customCreateMint(6); // Mock USDC (6 decimals)
  console.log(`  Mock USDC Mint: ${tokenMintY.toBase58()}`);

  // Derive PDAs
  const [pool0Pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMintX.toBuffer(), tokenMintY.toBuffer(), Buffer.from([0])],
    program.programId
  );
  const [vault0XPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_x"), pool0Pda.toBuffer()], program.programId);
  const [vault0YPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_y"), pool0Pda.toBuffer()], program.programId);
  const [lpMint0Pda] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool0Pda.toBuffer()], program.programId);

  const [pool1Pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMintX.toBuffer(), tokenMintY.toBuffer(), Buffer.from([1])],
    program.programId
  );
  const [vault1XPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_x"), pool1Pda.toBuffer()], program.programId);
  const [vault1YPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_y"), pool1Pda.toBuffer()], program.programId);
  const [lpMint1Pda] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool1Pda.toBuffer()], program.programId);

  console.log("\n2. Initializing Pools...");
  console.log(`  Pool #0 PDA: ${pool0Pda.toBase58()}`);
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

  console.log(`  Pool #1 PDA: ${pool1Pda.toBase58()}`);
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

  console.log("\n3. Setting Up User Token Accounts & Minting Liquidity...");
  const payerTokenX = getAssociatedTokenAddressSync(tokenMintX, payer.publicKey);
  const payerTokenY = getAssociatedTokenAddressSync(tokenMintY, payer.publicKey);
  const payerLp0 = getAssociatedTokenAddressSync(lpMint0Pda, payer.publicKey);
  const payerLp1 = getAssociatedTokenAddressSync(lpMint1Pda, payer.publicKey);

  const setupAtaTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, payerTokenX, payer.publicKey, tokenMintX),
    createAssociatedTokenAccountInstruction(payer.publicKey, payerTokenY, payer.publicKey, tokenMintY),
    createAssociatedTokenAccountInstruction(payer.publicKey, payerLp0, payer.publicKey, lpMint0Pda),
    createAssociatedTokenAccountInstruction(payer.publicKey, payerLp1, payer.publicKey, lpMint1Pda),
    // Mint 2,500 Mock SOL and 250,000 Mock USDC
    createMintToInstruction(tokenMintX, payerTokenX, payer.publicKey, 2_500_000_000_000),
    createMintToInstruction(tokenMintY, payerTokenY, payer.publicKey, 250_000_000_000)
  );
  await sendTx(setupAtaTx, [payer]);

  console.log("\n4. Depositing Initial Liquidity (Recreating Vector 4 Discrepancy)...");
  // Pool 0: 1,000 SOL / 100,000 USDC (Price = 100.0)
  console.log("  Depositing into Pool #0 (1,000 SOL / 100,000 USDC)...");
  await program.methods
    .addLiquidity(new BN(1_000_000_000_000), new BN(100_000_000_000), new BN(1))
    .accounts({
      provider: payer.publicKey,
      pool: pool0Pda,
      userTokenX: payerTokenX,
      userTokenY: payerTokenY,
      tokenVaultX: vault0XPda,
      tokenVaultY: vault0YPda,
      lpMint: lpMint0Pda,
      userLp: payerLp0,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // Pool 1: 1,000 SOL / 105,000 USDC (Price = 105.0)
  console.log("  Depositing into Pool #1 (1,000 SOL / 105,000 USDC)...");
  await program.methods
    .addLiquidity(new BN(1_000_000_000_000), new BN(105_000_000_000), new BN(1))
    .accounts({
      provider: payer.publicKey,
      pool: pool1Pda,
      userTokenX: payerTokenX,
      userTokenY: payerTokenY,
      tokenVaultX: vault1XPda,
      tokenVaultY: vault1YPda,
      lpMint: lpMint1Pda,
      userLp: payerLp1,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const devnetConfig = {
    programId: program.programId.toBase58(),
    tokenMintX: tokenMintX.toBase58(),
    tokenMintY: tokenMintY.toBase58(),
    pool0: {
      index: 0,
      pda: pool0Pda.toBase58(),
      vaultX: vault0XPda.toBase58(),
      vaultY: vault0YPda.toBase58(),
      lpMint: lpMint0Pda.toBase58(),
      initialPrice: 100.0,
    },
    pool1: {
      index: 1,
      pda: pool1Pda.toBase58(),
      vaultX: vault1XPda.toBase58(),
      vaultY: vault1YPda.toBase58(),
      lpMint: lpMint1Pda.toBase58(),
      initialPrice: 105.0,
    },
    coordinator: coordinator.publicKey.toBase58(),
    network: rpcUrl,
  };

  const configPath = path.join(process.cwd(), "devnet-pools.json");
  fs.writeFileSync(configPath, JSON.stringify(devnetConfig, null, 2));

  console.log("\n=================================================");
  console.log("       Devnet Configuration Saved!               ");
  console.log("=================================================");
  console.log(`Config file written to: ${configPath}`);
  console.log(JSON.stringify(devnetConfig, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(console.error);
}
