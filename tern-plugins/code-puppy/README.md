# Code Puppy Tern plugin (lane: trebol/tern-plugins/code-puppy)

Status: linked and loaded in the local Tern daemon (`tern plugin list --json`
reported `status: ready`, no problems). This is the **Tern launcher and status
half**; `python-plugin/` is Code Puppy's plugin for native final responses.
Together they are not yet an omp-equivalent native chat UI. Launch and interrupt
commands have not been exercised against a real Code Puppy process.

## Files
- `plugin.toml`: schema 1 manifest; one block `status`, two entries.
- `host.luau`: block `code-puppy.status` (kind `code-puppy.status`). Runs
  `command -v code-puppy` via `tern.process.run` and shows the result; `r` re-checks.
- `window.luau`: palette commands (Start, Status, Interrupt, Stop) using
  `cx.layout:new_tab`, `cx.session:panes`, `cx:run`, and `cx.layout:close`.
  Pane id is stored in `tern.kv`. It does not inject an initial prompt.

## Coverage vs. the Code Puppy TSP integration (1:1 is NOT possible here)
| Capability | Plugin API | Notes |
| --- | --- | --- |
| Launch Code Puppy pane | Yes | `cx.layout:new_tab({command="code-puppy"})`; uses the ordinary terminal pane rather than the omp-specific agent API. |
| Send prompt | In its own terminal pane | The plugin deliberately does not inject or capture prompts; Code Puppy keeps stdin and approval ownership. |
| Read reply | Pane only | No agent transcript API for Code Puppy; `cx.agents:transcript` is omp-only. |
| Full chat / streamed output | No | Plugins only return views; no duplex stream API. Needs producer-side TSP (Code Puppy emits TSP itself) or a supervised bridge process. |
| Native Markdown rendering of final replies | Partial | The separate `python-plugin` claims a generic Code Puppy renderer callback and emits a TSP `flow` surface. Streaming and tools still use Rich. |
| Approvals / stdin control | No | Would take over the pane's stdin; out of scope. |

## Preserved prior Code Puppy work
The direct TSP experiment originally modified `code_puppy/cli_runner.py` and
`code_puppy/messaging/rich_renderer.py` and added `code_puppy/tern_surface.py`,
`tests/test_tern_surface.py`, and `docs/tern-integration-handoff.md`. These
original bytes and the full diff were copied to the snapshot below; those
direct imports are not part of the current working integration.
The earlier direct TSP edits were preserved in the recoverable snapshot at
`/Users/swarm/Work/Clover/_tern_legacy_backup_20261011_153130` before direct
wiring was disabled. The working Code Puppy checkout now adds only a generic
`render_final_response` hook in core; all Tern-specific output is in
`python-plugin/`. This is a **two-plugin integration**, not Tern Luau alone.
Native *streaming* chat cannot be supplied by the documented one-shot
`tern.process.run` interface or the current final-response hook. Do not
describe this as 1:1 omp UI parity.

## Verification and removal

- `tern plugin types tern-plugins/code-puppy` wrote the local generated API
  declarations; `tern plugin link tern-plugins/code-puppy --json` returned the
  id and path; `tern plugin reload --json` and `tern plugin list --json`
  reported `ready` and no problems on this machine.
- The linked plugin is in the user's Tern configuration. To remove just the
  registration: `tern plugin unlink code-puppy` (the source directory remains).
- A live command invocation, Code Puppy availability on the daemon's PATH,
  approval behavior, and full GUI rendering have not been verified.

## Docs used
tern-site: guides/blocks.md, io.md, commands.md, hooks.md; reference/manifest.md,
api-window.md (Agent cx), api-host.md, ui.md; tern-sdk/api/tern.d.luau.
