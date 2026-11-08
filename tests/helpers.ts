import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";

export async function sendAndConfirmHttp(
  connection: Connection,
  tx: Transaction,
  signers: Signer[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  if (!tx.feePayer) {
    tx.feePayer = signers[0].publicKey;
  }
  tx.sign(...signers);
  const rawTx = tx.serialize();
  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  const start = Date.now();
  while (Date.now() - start < 20000) {
    const res = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (res && res.value) {
      if (res.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
      }
      if (res.value.confirmationStatus === "confirmed" || res.value.confirmationStatus === "finalized") {
        return sig;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return sig;
}

/**
 * Creates and initializes a new SPL token mint using HTTP-only confirmation
 */
export async function createMintHttp(
  connection: Connection,
  payer: Signer,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number
): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptMint(connection);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      mintAuthority,
      freezeAuthority,
      TOKEN_PROGRAM_ID
    )
  );

  await sendAndConfirmHttp(connection, tx, [payer, mint]);
  return mint.publicKey;
}
