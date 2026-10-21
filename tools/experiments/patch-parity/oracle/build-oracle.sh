#!/bin/sh
# Builds the pinned upstream apply_patch writer and the Trebol agent-path harness.
# Upstream: openai/codex @ 430a16799d90e296fb27b1e94f206023902b7e56 (Apache-2.0).
# Requires cargo 1.99.1 (rust-toolchain.toml pins it). Outputs stay under artifacts/ (gitignored).
set -eu
SHA=430a16799d90e296fb27b1e94f206023902b7e56
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
ART="$ROOT/artifacts/patch-parity"
SRC="$ART/codex"
mkdir -p "$ART"
if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/openai/codex.git "$SRC"
fi
git -C "$SRC" sparse-checkout set codex-rs
git -C "$SRC" fetch --filter=blob:none origin "$SHA"
git -C "$SRC" reset -q --hard "$SHA"
mkdir -p "$SRC/codex-rs/apply-patch/examples"
cp "$ROOT/tools/experiments/patch-parity/oracle/trebol_oracle.rs" "$SRC/codex-rs/apply-patch/examples/trebol_oracle.rs"
cd "$SRC/codex-rs"
cargo build --locked -p codex-apply-patch --bin apply_patch --example trebol_oracle
echo "CODEX_APPLY_PATCH_BIN=$SRC/codex-rs/target/debug/apply_patch"
echo "CODEX_TREBOL_ORACLE_BIN=$SRC/codex-rs/target/debug/examples/trebol_oracle"
