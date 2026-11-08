# Pane runtime: install detection, consent-based install, and a herdr fallback

Status: proposed · Owner: agent · Supersedes nothing

## Problem

The `tern` tool is advertised in every session. When the binary cannot be resolved, every
call fails with `spawn tern ENOENT` and there is no install path offered. This produced at
least three duplicate reports (#412, #413, #417) and blocks all browser-driven QA.

Contributing fact found while investigating: `tern` *is* installed on this host
(`/home/robert/.local/bin/tern`), so `ENOENT` is a **resolution** failure, not a missing
install. The symlink points into `Tern-0.9.5-linux-x86_64/` while the binary self-reports
`0.9.12`, so version drift is also invisible today.

## Verified facts (evidence)

| Fact | Evidence |
|---|---|
| `tern` resolves on this host | `command -v tern` → `/home/robert/.local/bin/tern`; `tern --version` → `0.9.12` |
| Symlink directory disagrees with binary version | symlink target `Tern-0.9.5-linux-x86_64/tern/tern` vs reported `0.9.12` |
| `herdr` is a real project | `herdrdev/herdr`, Apache-2.0, 48,775 stars, pushed 2026-11-03, latest `v0.9.5` |
| npm `herdr` is only a reserved placeholder | `herdr@0.0.0`, description "Reserved package name for Herdr" |
| herdr installs cleanly without sudo | official `install.sh`: manifest + SHA-256 verify → `~/.local/bin/herdr`; verified `herdr 0.9.5` |
| herdr reports failure as a JSON envelope on **stderr** with **exit 1** | `herdr pane list >o 2>e` → rc=1, stdout empty, `{"error":{"code":"server_not_running"}}` on stderr. (An earlier reading of "exit 0" was a `$?`-after-a-pipe artifact, corrected during implementation.) |
| herdr needs a running server | `herdr status` → `server: not running`; `herdr server` is the headless mode |
| herdr cannot do browsers | CLI surface is session/workspace/tab/pane/agent only |
| state belongs outside the repo | `.pi/lib/state/workspace-state.ts`: `$PI_SWARM_STATE_DIR` → `$XDG_STATE_HOME/pi-swarm` → `~/ln/pi-swarm` |

## Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| D1 | Browser ops on a non-tern backend | **Not exposed at all.** No `open/blocks/goto/snapshot/act/capture` in the tool schema when tern is unavailable. Owner instruction: this work is agent orchestration and pane management only. |
| D2 | When to prompt | **Once at session start, dismissible.** A decline is remembered per workspace so it never nags. |
| D3 | Server lifecycle for herdr | The adapter **never silently starts a server**. `server_not_running` is reported as such with an offer to start one; a silent `herdr server` spawn would leak a long-lived process. |
| D4 | Where "declined" state lives | `workspaceStateDir()` from `.pi/lib/state/workspace-state.ts`. Never the repository. |

## Breakdown

### WHAT I NEED

- A probe that resolves `tern` and `herdr` **without trusting the inherited PATH**:
  `execFile` inherits the pane's PATH, which is what fails today. Resolution order:
  explicit `PI_SWARM_TERN_BIN` / `PI_SWARM_HERDR_BIN` override → `PATH` entries →
  `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`.
- Version for each binary (spawn `--version`; a probe that hangs is a failure, bounded by a
  timeout, and a non-zero exit is "absent", not "present but broken").
- Capability descriptor per backend: `{ panes: boolean, browser: boolean }`.
- The existing `Deps` seam in `.pi/lib/tern/browser.ts` (`paneId, owned, signal, inspect,
  browser, tern`) — reused unchanged for tern; a parallel implementation for herdr.
- A TUI confirm surface; `.pi/lib/ui/tern-setup-wizard.ts` is the precedent
  (`ctx.mode === "tui"`, `ctx.hasUI`, TTY check, returns a string status).
- A Tern UI card surface; `.pi/lib/tern/startup-card.ts` is the precedent.

### WHAT I EXPECT

- Probe returns `{ tern?: {path, version}, herdr?: {path, version, serverRunning} }` and
  never throws.
- `tern` present → tool schema is exactly as today (14 ops). Behaviour unchanged.
- `tern` absent, `herdr` present → schema carries only the 9 terminal ops
  (`list, new_tab, rename_tab, split, focus, close, send, read`) plus no browser ops.
- `tern` absent, `herdr` absent → tool is not registered at all, and one dismissible prompt
  offers to install either.
- Every herdr call scans **both** streams for an `{error:{code}}` envelope and throws a typed
  error with the code preserved. Exit status is never trusted: a refusal can arrive with a
  non-zero exit, and treating "no throw" as success is how a backend reports work it never did.
- Declining the prompt writes `declined` to the workspace state and suppresses the prompt
  for that workspace thereafter.

### HOW LOGIC WORKS

1. Extension load → `probePaneRuntime()`. Per binary: resolve path → spawn `--version` with
   a 5s timeout → record `{path, version}` or omit.
2. Build capabilities from the probe: tern ⇒ `{panes:true, browser:true}`, else herdr ⇒
   `{panes:true, browser:false}`, else nothing.
3. Register the tool with `OPS` filtered by capabilities. Schema and dispatcher read the
   same filtered list, so an unexposed op cannot be reached through a hand-written call.
4. At session start, if a runtime is missing and this workspace has not declined, show one
   confirm. On accept, print the exact command, then run the official installer
   (`herdr`: `curl -fsSL https://herdr.dev/install.sh | sh`; `tern`: the documented download,
   not a guessed URL) and re-probe.
5. Dispatch: op → backend method → herdr CLI invocation → JSON envelope parsed →
   `ok` returned or typed error thrown.

Breaking points, called out before implementation:

- **errors are envelopes, not exit codes** (verified above) — parsing both streams is mandatory,
  not defensive.
- **`HERDR_ENV=1`** — herdr blocks nested launch; a probe run inside a herdr pane must not
  try to start a server.
- **PTY requirement** — `send`/`read` need a live pane; `new_tab` on herdr needs a workspace,
  which needs a server. Headless callers get a typed `server_not_running`, not a fake success.
- **Ownership scope** — `close`/`rename_tab` must stay limited to blocks this process
  created, preserving the existing `Ownership` invariant.

## Implementation steps

1. **New** `.pi/lib/panes/install-probe.ts` — path resolution + version probe + capabilities.
2. **New** `.pi/lib/panes/herdr.ts` — CLI adapter for the 9 terminal ops; JSON envelope
   parsing; typed errors.
3. **New** `.pi/lib/panes/backend.ts` — `PaneBackend` interface, `TernBackend` adapting the
   current `Deps`, backend selection from the probe.
4. **Edit** `extensions/tern-browser/extension.ts` — register filtered ops from capabilities.
5. **Edit** `.pi/lib/tern/browser.ts` — export `OPS` subsets and accept the capability filter;
   keep `runTern` behaviour identical when tern is present.
6. **New** `.pi/lib/ui/pane-runtime-setup.ts` — the dismissible session-start confirm,
   memory in workspace state, consent-gated install.
7. **Edit** Tern UI startup card — runtime status row plus install/refresh affordance.
8. **Docs** — AGENTS.md capability note, CHANGELOG entry, `docs/reference/tern-pi-rendered-regression.md`
   note on the degraded surface.

## Delegation

`herdr.ts` + its tests were delegated to a subagent with this document as the brief; the
probe, schema filtering, dispatch, prompts and docs stayed with the primary agent.

Two findings from that work that changed this document: herdr reports failure on stderr with a
non-zero exit (corrected above), and `pane focus` has no "focus this pane" verb in 0.9.5 — only
`pane focus --direction` (move to a neighbour) and `tab focus <tab_id>`. The adapter therefore
raises the pane's **tab** and reports `level: "tab"` rather than pretending a pane focus
happened.

## Validation

```sh
npm run build
npx vitest run .pi/test/panes .pi/test/tern/browser
npm test
node tools/repo/rewrite-imports.mjs --check
```

- Probe test: fake PATH with no binaries, with only herdr, with both.
- Adapter test: a fake `herdr` executable returning the observed exit-0 error envelope must
  raise `server_not_running`, not resolve.
- Schema test: herdr-only capabilities expose exactly 9 ops and no browser op.
- Regression: with tern present, `.pi/test/tern/browser.test.ts` stays green unchanged.

## Non-goals

- Browser automation on any non-tern backend (explicitly out of scope per D1).
- tmux as a third backend.
- Installing anything without an explicit confirmation.

## Open risk

`tern` resolution may differ per pane in ways a static PATH order cannot fix (e.g. a pane
whose PATH was captured before `~/.local/bin` existed). The probe reports the resolved path
in its error, so the next report carries the answer instead of another `ENOENT`.
