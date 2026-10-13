# Tern integration status (2026-10-11)

## Pi (trebol)

The opt-in runner `.pi/lib/tern/run.ts` creates a Pi SDK session and opens a TSP
inline surface. `bridge.ts` projects user/assistant text, streamed text deltas,
tool start/update/end cards, model/status, and a docked editor. `tsp.ts` sends
keyed frame differences and observes Tern's ack credits. The default Pi CLI
has **not** been replaced. Run the prototype only by explicitly launching
`node --experimental-strip-types .pi/lib/tern/run.ts` in a Tern pane.

Focused checks: `npx vitest run .pi/test/tern/` passed 48 tests; targeted strict
TypeScript on `.pi/lib/tern/*.ts` passed. In a focused live Tern pane, the
prompt `Reply with exactly: UI_PARITY_CHECK` produced `UI_PARITY_CHECK`; two
idle Escape presses exited with status 0. Tool-update and toolResult dedupe
paths are unit-tested but not live-observed. Earlier stray draft text was not
reproduced after moving draft ownership into the bridge.

**Not omp 1:1:** no verified extension UI dialogs/approval overlays, thinking
blocks, model/session pickers, image support, restored transcript, native
editing/undo/send, or visual snapshot comparison. The bridge deliberately
does not advertise unsupported `edit`, `undo`, or `send` features. Its unbound
extension UI denies confirmations and returns no selection or text; that
may leave workflows unable to proceed. Live cancellation and resume remain
unverified. Do not use as the default frontend for authorization-sensitive
work until those gaps are closed.

## Code Puppy

`tern-plugins/code-puppy/` has a Luau Tern launcher/status plugin (local
`tern plugin list --json` reported `ready`, no problems) and a separate Python
plugin loaded by Code Puppy at `~/.code_puppy/plugins/tern`. The Code Puppy
checkout at `/Users/swarm/Work/Clover/code_puppy` branch `tern-integration`
contains only a user-approved generic `render_final_response` core hook; the
Tern-specific renderer stays in the Python plugin. The prior direct TSP work
is recoverable from `/Users/swarm/Work/Clover/_tern_legacy_backup_20261011_153130`.

Focused checks: 15 generic-hook tests, 18 Python plugin tests through the real
loader, and 135 selected Code Puppy CLI/approval tests passed. A no-provider
live Tern pane displayed `PLUGIN_FLOW_CHECK` once through the plugin. It
renders only **final non-streamed** agent responses as native Markdown;
streaming, tools, dialogs, and full omp chat remain Rich/Code Puppy-owned.
The Luau launch/interrupt actions and an actual agent conversation have not
been live-verified. The two plugins are independently disableable: unlink the
Tern plugin via `tern plugin unlink code-puppy`, and unlink
`~/.code_puppy/plugins/tern` for the Python renderer. Do not remove the legacy
backup while it is the only saved copy of the former direct implementation.
