#!/usr/bin/env bash
set -euo pipefail

source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "Running anchor build in $DIR..."
anchor build
echo "Anchor build complete!"
