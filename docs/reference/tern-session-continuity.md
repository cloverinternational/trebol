# Tern session continuity

## Findings

The installed shell dispatches bare `pi` to `.pi/lib/tern/run.ts`;
`pi -nt` bypasses that bridge. Both observed Pi and OMP processes were
descendants of Tern's session daemon. Window detachment alone should retain
their PTYs. Tern documents that drawing ACKs stop without a visible window
and resume when a window draws the retained document:
https://docs.stencil.so/tern/protocol/operations.md

Source inspection found two bridge gaps: events addressed to another surface
could close Pi, and a whole-surface `gone` notification was ignored, leaving
the bridge diffing a document that no longer existed. Neither is established
as the cause of the user's reported window-close failure.

OMP's installed executable emits OSC 1337 keys `omp_session_file` and
`omp_restore`; the installed Tern binary contains those names. Pi must not
impersonate OMP: restoring a Pi JSONL through OMP is not a supported solution.
The complete host restore implementation was not available for inspection.

## Changes

- `bridge.ts` rejects events explicitly scoped to another surface.
- `tsp.ts` reopens a lost whole surface with the latest pending/sent document
  and styles. Session identity, running work and draft remain in the bridge.
- Sequence numbers remain monotonic; invalid/future ACKs are ignored.
- A closed surface cannot be resurrected by a delayed event.
- No timers, signal ignoring, auto-submission or automatic process relaunch.

## Verification

Focused command: `npx --no-install vitest run .pi/test/tern/tsp.test.ts
.pi/test/tern/bridge.test.ts .pi/test/tern/dock.test.ts --testTimeout=15000`.
The initial 5-second run had 91 passes and one autocomplete timeout; that
test passed alone, and the repeated focused suite passed all 92 tests.
Regressions cover pending-view reconstruction, stylesheet replay, stale/future
ACK rejection, foreign close, draft/subscription preservation and explicit close.

The user subsequently reported that closing/reopening Tern retained this
conversation. This is a user-reported smoke result, not an instrumented test
of the patch: the running bridge was not proven to have reloaded the changed
implementation. It does not establish the original failure's root cause.

## Limits and activation

No real user window/session was closed. Actual desktop detach/reattach and
the reported process exit have not been reproduced: this is tested hardening,
not a verified resolution of the full incident. Node process death, daemon
restart and automatic continuation of an interrupted model/tool turn are
not implemented here. `tern-resume` selects stored history; the tmux extension
only records pane/session mappings.

New bridge processes load the changes. `/reload` reloads extensions/styles,
not the imported bridge implementation; finish active work before reopening
Pi, then use `/tern-resume` to select the existing conversation as needed.
Do not restart the daemon or close working tabs just to activate this patch.
