#!/usr/bin/env bash
# ==============================================================================
# PoolSync Devnet Deployment Script
# Safety: Devnet only. Never mainnet. Generates fresh throwaway keypairs.
# ==============================================================================
set -euo pipefail

source "$HOME/.cargo/env" || true
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "================================================="
echo "       PoolSync Devnet Deployment Pipeline       "
echo "================================================="

DEVNET_RPC="https://api.devnet.solana.com"
solana config set --url "$DEVNET_RPC"

KEYS_DIR="$DIR/keys"
mkdir -p "$KEYS_DIR"
DEPLOYER_KEY="$KEYS_DIR/devnet-deployer.json"

if [ ! -f "$DEPLOYER_KEY" ]; then
    echo "Generating fresh throwaway deployer keypair..."
    solana-keygen new --no-bip39-passphrase --silent --outfile "$DEPLOYER_KEY"
fi

DEPLOYER_PUBKEY="$(solana-keygen pubkey "$DEPLOYER_KEY")"
echo "Deployer Public Key: $DEPLOYER_PUBKEY"

# Check balance
BALANCE_LAMPORT="$(solana balance "$DEPLOYER_PUBKEY" --lamports 2>/dev/null || echo 0)"
BALANCE_SOL="$(awk -v b="$BALANCE_LAMPORT" 'BEGIN {print b / 1000000000}')"
echo "Deployer Balance: $BALANCE_SOL SOL"

if (( $(echo "$BALANCE_SOL < 3.0" | bc -l 2>/dev/null || echo 1) )); then
    echo "Requesting devnet airdrop (2 SOL)..."
    solana airdrop 2 "$DEPLOYER_PUBKEY" --url "$DEVNET_RPC" || true
    sleep 3
    solana airdrop 2 "$DEPLOYER_PUBKEY" --url "$DEVNET_RPC" || true
fi

echo "Building Anchor program for Devnet..."
anchor build

PROGRAM_SO="$DIR/target/deploy/pool_sync.so"
PROGRAM_KEYPAIR="$DIR/target/deploy/pool_sync-keypair.json"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"

echo "Deploying PoolSync Program ($PROGRAM_ID) to Devnet..."
solana program deploy \
    --keypair "$DEPLOYER_KEY" \
    --program-id "$PROGRAM_KEYPAIR" \
    --url "$DEVNET_RPC" \
    "$PROGRAM_SO"

echo "================================================="
echo "       PoolSync Successfully Deployed!           "
echo "================================================="
echo "Program ID:   $PROGRAM_ID"
echo "Network:      $DEVNET_RPC"
echo "Deployer:     $DEPLOYER_PUBKEY"
echo "Explorer:     https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
