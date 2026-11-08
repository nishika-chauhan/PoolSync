#!/usr/bin/env bash
set -e

source "$HOME/.cargo/env"
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "Cleaning up any old validator..."
killall solana-test-validator 2>/dev/null || true
sleep 1

echo "Starting solana-test-validator with pool_sync program preloaded..."
solana-test-validator \
    --bpf-program D2nX6JxARw7hhWvaSRgRC43tAtBRX2K6pQkbup26T4ik target/deploy/pool_sync.so \
    --reset --quiet &
VAL_PID=$!
trap "kill $VAL_PID 2>/dev/null || true" EXIT

echo "Waiting for validator RPC to be ready and reach slot 40..."
while true; do
    SLOT=$(solana slot --url http://127.0.0.1:8899 2>/dev/null || echo 0)
    if [ "$SLOT" -ge 40 ]; then
        echo "Validator ready at slot $SLOT!"
        break
    fi
    sleep 1
done

export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"

echo "Running Phase 1 Test Suite (Core AMM)..."
npx tsx node_modules/mocha/bin/mocha.js -t 120000 tests/pool_sync.ts

echo "Running Phase 2 Test Suite (Multi-Pool Atomic Rebalance)..."
npx tsx node_modules/mocha/bin/mocha.js -t 120000 tests/rebalance.ts
