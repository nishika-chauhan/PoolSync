import { fileURLToPath } from "url";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PoolSync } from "../target/types/pool_sync";
import idl from "../target/idl/pool_sync.json";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";

// Helper to parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options: { [key: string]: any } = {
    rpc: process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899",
    keypair: process.env.ANCHOR_WALLET || path.join(process.env.HOME || process.env.USERPROFILE || "", ".config/solana/id.json"),
    mintX: "",
    mintY: "",
    pools: [0, 1],
    minGapBps: 5,
    toleranceBps: 20,
    dryRun: false,
    once: false,
    interval: 5,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--rpc" && i + 1 < args.length) options.rpc = args[++i];
    else if (arg === "--keypair" && i + 1 < args.length) options.keypair = args[++i];
    else if (arg === "--mint-x" && i + 1 < args.length) options.mintX = args[++i];
    else if (arg === "--mint-y" && i + 1 < args.length) options.mintY = args[++i];
    else if (arg === "--pools" && i + 1 < args.length) {
      options.pools = args[++i].split(",").map((s: string) => parseInt(s.trim(), 10));
    }
    else if (arg === "--min-gap-bps" && i + 1 < args.length) options.minGapBps = parseFloat(args[++i]);
    else if (arg === "--tolerance-bps" && i + 1 < args.length) options.toleranceBps = parseInt(args[++i], 10);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--once") options.once = true;
    else if (arg === "--interval" && i + 1 < args.length) options.interval = parseInt(args[++i], 10);
  }

  return options;
}

export async function runKeeper(opts = parseArgs()) {
  console.log("=================================================");
  console.log("       PoolSync Autonomous Keeper Service        ");
  console.log("=================================================");
  console.log(`RPC Endpoint:   ${opts.rpc}`);
  console.log(`Keypair Path:   ${opts.keypair}`);
  console.log(`Min Gap Trigger: ${opts.minGapBps} bps`);
  console.log(`Execution Mode: ${opts.dryRun ? "DRY-RUN (Simulation Only)" : "LIVE (On-Chain Execution)"}`);

  const connection = new anchor.web3.Connection(opts.rpc, "processed");

  // Monkey-patch confirmTransaction to use HTTP polling to avoid WSL WebSocket hang
  connection.confirmTransaction = (async (strategyOrSignature: any, commitment?: any) => {
    const signature = typeof strategyOrSignature === "string" ? strategyOrSignature : strategyOrSignature.signature;
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const res = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
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

  // Load Coordinator Keypair
  let coordinator: Keypair;
  if (fs.existsSync(opts.keypair)) {
    const secret = JSON.parse(fs.readFileSync(opts.keypair, "utf-8"));
    coordinator = Keypair.fromSecretKey(Uint8Array.from(secret));
  } else {
    throw new Error(`Coordinator keypair not found at ${opts.keypair}`);
  }
  console.log(`Coordinator:    ${coordinator.publicKey.toBase58()}`);

  const wallet = new anchor.Wallet(coordinator);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "processed",
    preflightCommitment: "processed",
  });
  anchor.setProvider(provider);

  const program = new Program<PoolSync>(idl as any, provider);

  // Auto-detect mints from existing pools if not passed explicitly
  let mintX: PublicKey;
  let mintY: PublicKey;

  if (opts.mintX && opts.mintY) {
    mintX = new PublicKey(opts.mintX);
    mintY = new PublicKey(opts.mintY);
  } else {
    // Attempt to discover from config or all pools on chain
    const allPools = await program.account.pool.all();
    if (allPools.length < 2) {
      console.log("Waiting for at least 2 pools to exist on chain...");
      if (opts.once) return;
      await new Promise(r => setTimeout(r, opts.interval * 1000));
      return;
    }
    mintX = allPools[0].account.tokenMintX;
    mintY = allPools[0].account.tokenMintY;
    console.log(`Auto-discovered pair:`);
    console.log(`  Token X: ${mintX.toBase58()}`);
    console.log(`  Token Y: ${mintY.toBase58()}`);
  }

  let iteration = 0;
  while (true) {
    iteration++;
    console.log(`\n--- [Cycle #${iteration}] Polling participating pools ---`);

    try {
      const poolInfos: any[] = [];
      const remainingAccounts: any[] = [];

      for (const idx of opts.pools) {
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool"), mintX.toBuffer(), mintY.toBuffer(), Buffer.from([idx])],
          program.programId
        );
        const [vaultXPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_x"), poolPda.toBuffer()],
          program.programId
        );
        const [vaultYPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_y"), poolPda.toBuffer()],
          program.programId
        );

        const poolAcc = await program.account.pool.fetch(poolPda);
        const rx = poolAcc.reserveX.toNumber();
        const ry = poolAcc.reserveY.toNumber();
        const price = rx > 0 ? (ry / 1e6) / (rx / 1e9) : 0;

        poolInfos.push({
          index: idx,
          pda: poolPda,
          vaultX: vaultXPda,
          vaultY: vaultYPda,
          reserveX: poolAcc.reserveX,
          reserveY: poolAcc.reserveY,
          rx,
          ry,
          price,
          optIn: poolAcc.policy.optIn,
          paused: poolAcc.policy.paused,
          coordinator: poolAcc.policy.coordinator,
        });

        remainingAccounts.push(
          { pubkey: poolPda, isWritable: true, isSigner: false },
          { pubkey: vaultXPda, isWritable: true, isSigner: false },
          { pubkey: vaultYPda, isWritable: true, isSigner: false }
        );

        console.log(`  Pool #${idx} (${poolPda.toBase58().slice(0, 8)}...): ` +
          `ReserveX=${(rx / 1e9).toFixed(4)} SOL, ` +
          `ReserveY=${(ry / 1e6).toFixed(4)} USDC | ` +
          `Spot Price: ${price.toFixed(4)} USDC/SOL | ` +
          `OptIn: ${poolAcc.policy.optIn}, Paused: ${poolAcc.policy.paused}`
        );
      }

      // Check opt-in and pause
      for (const p of poolInfos) {
        if (!p.optIn) {
          console.log(`[Keeper] Pool #${p.index} is not opted in. Skipping cycle.`);
          if (opts.once) return;
          continue;
        }
        if (p.paused) {
          console.log(`[Keeper] Pool #${p.index} is paused. Skipping cycle.`);
          if (opts.once) return;
          continue;
        }
      }

      // Calculate price gap
      const prices = poolInfos.map(p => p.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const gapBps = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 10000 : 0;

      console.log(`\nPrice Gap: ${gapBps.toFixed(2)} bps (Min Threshold: ${opts.minGapBps} bps)`);

      if (gapBps < opts.minGapBps) {
        console.log(`Pools are in equilibrium. No rebalance needed.`);
      } else {
        console.log(`[TRIGGER] Price gap ${gapBps.toFixed(2)} bps exceeds ${opts.minGapBps} bps!`);
        console.log(`Invoking Convex Reference Solver...`);

        // Prepare input for python solver
        const solverInput = poolInfos.map(p => ({
          x: p.rx,
          y: p.ry,
          weight: 1.0,
        }));

        const tmpFile = `tmp_solver_${Date.now()}.json`;
        fs.writeFileSync(tmpFile, JSON.stringify(solverInput, null, 2));

        let solverOutput: any;
        try {
          const stdout = execFileSync(process.env.PYTHON_BIN || "python", [
            "solver/solver.py",
            "--raw-units",
            "--pools-file",
            tmpFile,
          ], { encoding: "utf-8" });
          solverOutput = JSON.parse(stdout);
        } finally {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }

        console.log(`Solver Status:       ${solverOutput.status}`);
        console.log(`Arbitrage Free:      ${solverOutput.is_arbitrage_free}`);
        console.log(`Target Common Price: ${solverOutput.common_price.toFixed(4)} USDC/SOL`);

        if (!solverOutput.is_arbitrage_free) {
          console.error(`[Keeper] Solver solution failed arbitrage-free check! Aborting.`);
          if (opts.once) return;
          continue;
        }

        // Format transfers for Anchor
        const anchorTransfers = solverOutput.transfer_hops.map((hop: any) => ({
          fromPool: hop.from_pool,
          toPool: hop.to_pool,
          isTokenX: hop.is_token_x,
          amount: new BN(hop.amount.toString()),
        }));

        const expectedReserves = poolInfos.map(p => ({
          reserveX: p.reserveX,
          reserveY: p.reserveY,
        }));

        console.log("\nComputed Optimal Transfer Hops:");
        for (const h of anchorTransfers) {
          const tokenName = h.isTokenX ? "SOL" : "USDC";
          const humanAmount = h.isTokenX ? (h.amount.toNumber() / 1e9).toFixed(6) : (h.amount.toNumber() / 1e6).toFixed(6);
          console.log(`  Pool #${h.fromPool} -> Pool #${h.toPool}: ${humanAmount} ${tokenName}`);
        }

        if (opts.dryRun) {
          console.log("\n[DRY-RUN] Rebalance simulated successfully. No transaction broadcasted.");
        } else {
          console.log("\nBroadcasting atomic rebalance transaction on-chain...");

          const txSig = await program.methods
            .rebalance(anchorTransfers, expectedReserves, opts.toleranceBps)
            .accounts({
              coordinator: coordinator.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .remainingAccounts(remainingAccounts)
            .signers([coordinator])
            .rpc();

          console.log(`\n[SUCCESS] Rebalance confirmed on-chain!`);
          console.log(`Transaction Signature: ${txSig}`);
          console.log(`Explorer Link: https://explorer.solana.com/tx/${txSig}?cluster=custom&customUrl=${encodeURIComponent(opts.rpc)}`);
        }
      }
    } catch (err: any) {
      console.error(`[Keeper Error in cycle #${iteration}]:`, err.message || err);
    }

    if (opts.once) break;
    await new Promise(r => setTimeout(r, opts.interval * 1000));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runKeeper().catch(console.error);
}
