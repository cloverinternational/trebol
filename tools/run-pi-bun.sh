#!/usr/bin/env bash
set -euo pipefail

# Run Pi using the upstream package's Bun-specific entrypoint. This is opt-in:
# keep `pi` on its supported Node.js runtime unless the user explicitly switches.
if ! command -v bun >/dev/null 2>&1; then
	echo "Bun is required for this launcher" >&2
	exit 127
fi

pi_bin="$(command -v pi || true)"
if [[ -z "$pi_bin" ]]; then
	echo "Pi is not installed or not on PATH" >&2
	exit 127
fi

pi_real="$(realpath "$pi_bin")"
package_root="$(dirname "$(dirname "$(dirname "$pi_real")")")"
bun_entry="$package_root/dist/bun/cli.js"
if [[ ! -f "$bun_entry" ]]; then
	echo "This Pi installation does not provide its Bun entrypoint: $bun_entry" >&2
	exit 2
fi

exec bun "$bun_entry" "$@"
