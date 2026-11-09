#!/usr/bin/env bash
set -e

source "$HOME/.cargo/env" || true

mkdir -p "$HOME/bin"
if [ -f "/mnt/c/Python314/python.exe" ]; then
    ln -sf /mnt/c/Python314/python.exe "$HOME/bin/python"
    ln -sf /mnt/c/Python314/python.exe "$HOME/bin/python3"
fi

export PATH="$HOME/bin:$HOME/.nvm/versions/node/v24.10.0/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"
export PYTHON_BIN="python"
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

run_suite() {
    local suite_name="$1"
    local test_file="$2"

    echo ""
    echo "============================================================"
    echo " Running $suite_name"
    echo "============================================================"

    killall solana-test-validator 2>/dev/null || true
    sleep 1

    solana-test-validator \
        --bpf-program D2nX6JxARw7hhWvaSRgRC43tAtBRX2K6pQkbup26T4ik target/deploy/pool_sync.so \
        --reset --quiet &
    local val_pid=$!

    for i in $(seq 1 30); do
        if solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    npx tsx node_modules/mocha/bin/mocha.js -t 120000 "$test_file"
    kill $val_pid 2>/dev/null || true
    sleep 1
}

run_suite "Phase 1: Core AMM Program" "tests/pool_sync.ts"
run_suite "Phase 2: Multi-Pool Atomic Rebalance" "tests/rebalance.ts"
run_suite "Phase 3: Autonomous Keeper & Baseline Arbitrage Bot" "tests/keeper.ts"

echo ""
echo "============================================================"
echo " ALL TEST SUITES PASSED CLEANLY!"
echo "============================================================"
