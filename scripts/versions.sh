#!/usr/bin/env bash
source "$HOME/.cargo/env"
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"

echo "=== Toolchain Versions ==="
echo "rustc: $(rustc --version)"
echo "cargo: $(cargo --version)"
echo "solana: $(solana --version)"
echo "anchor: $(anchor --version)"
echo "node: $(node --version)"
echo "python3: $(python3 --version)"
