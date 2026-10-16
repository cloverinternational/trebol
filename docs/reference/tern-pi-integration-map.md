# Tern / pi / omp integration map

Status: research only. No recommendation is made here. No files under the tern-sdk directory were touched.

## Sources inspected

| Source | Location | State |
| --- | --- | --- |
| trebol repo | `/Users/swarm/Work/Clover/trebol` | present |
| pi-mono (coding-agent RPC) | `vendor/pi-mono/packages/coding-agent` | present, source |
| installed pi package | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` v1.1.0 | present, dist only |
| omp CLI | `/Users/swarm/.bun/bin/omp` | present, minified bun bundle |
| oh-my-pi submodule | `vendor/oh-my-pi` | empty (submodule not checked out) |
| tern-sdk repo | not local | only docs mirror at `docs/reference/tern-site/` |

Uncertainty: the omp contract below is inferred from string tokens in the minified bundle, not from source. pi-mono vendor is v0.78.1 (`vendor/pi-mono/packages/coding-agent/package.json:3`); installed dist is v1.1.0, so the two differ.

## Lifecycle

- **pi RPC (source)**: JSONL over stdin/stdout. `runRpcMode` takes over stdout and writes all output via `output()` (`vendor/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts:53-59`).
- Command loop: each stdin line is parsed in `handleInputLine` and responses are written after `handleCommand` (`rpc-mode.ts:~560-700`, `checkShutdownRequested` after each command).
- Prompt is acknowledged asynchronously: response emitted after start, errors via `error()` (`rpc-mode.ts:390-408`).
- Shutdown: `shutdown()` unsubscribes, calls `runtimeHost.dispose()`, then `process.exit` (`rpc-mode.ts:681-698`). Stdin `end` triggers shutdown (`rpc-mode.ts:758-760`). SIGHUP/SIGTERM also trigger shutdown (`rpc-mode.ts:371`).
- Client side: `RpcClient` spawns the process, correlates by `id`, and streams events through `onEvent` (`vendor/pi-mono/packages/coding-agent/src/modes/rpc/rpc-client.ts:54`, `:170`).
- **omp**: bundle contains `mode:"rpc` and `mode:"print` tokens (`/Users/swarm/.bun/bin/omp`, grep-level only). No lifecycle semantics verified.
- **trebol**: `extensions/swarm-auto/extension.ts:51` gates behavior on `event.source` being `"interactive"` or `"rpc"`, so trebol already assumes pi RPC source events.

## Commands and events

- **pi commands** (`rpc-types.ts:21-69`): `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, model/thinking/steering/follow-up settings, `compact`, auto-compaction and auto-retry toggles, `bash`, `export_html`, `switch_session`, `fork`, `clone`, `get_messages`, `get_commands`.
- **pi responses** (`rpc-types.ts:113-206`): typed `response` with `success` and optional `data`/`error`.
- **pi events**: `AgentSessionEvent` objects streamed on stdout (`rpc-mode.ts:355`). Extension errors as `extension_error` (`rpc-mode.ts:348`).
- **omp tokens**: `prompt` (157 hits), `abort` (337), `get_state`, `new_session`, `switch_session`, `set_auto_retry`, `extension_ui_request` (11). Shape and field sets unverified against source.
- **trebol**: `docs/architecture/swarm-tui-to-pi-map.md:271` describes a local `serve.Mux` exposing RPC/SSE/WebSocket, a separate transport from pi's stdin/stdout RPC.
- **tern**: TSP is not JSONL. It travels over the pane pty as APC or OSC 877 (`docs/reference/tern-site/protocol/sdks.md`; `docs/reference/tern-site-inventory.md:40`). Terminal-to-program replies use the pty input side. Different transport from pi RPC.

## Permissions and UI prompts

- **pi**: no permission model in RPC. Interactive decisions go through `extension_ui_request` (`rpc-types.ts:214-248`) and are answered with `extension_ui_response` (`rpc-types.ts:256-258`). Methods: `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.
- `confirm` defaults to `false` on abort, timeout, or cancel (`rpc-mode.ts:141-143`, `createDialogPromise` at `rpc-mode.ts:~110-135`).
- Extension context exposes `hasUI` (`vendor/pi-mono/packages/coding-agent/src/core/extensions/types.ts:306`, `:516`). Headless callers must handle `hasUI === false`.
- **omp**: `extension_ui_request` token present (11 hits). Permission semantics unverified.
- **tern**: `ask` form returns submit values (`docs/reference/tern-site/protocol/sdks.md`). Input is routed by surface and node id, not by a permission decision.
- **trebol ask-user**: remote bridge is in-process `pi.events` only, no network API (`extensions/ask-user/docs/remote-events.md`, channels `@eko24ive/pi-ask:started|completed|submit|submit-result`).

## Persistence

- **pi**: session file is owned by `SessionManager` (`vendor/pi-mono/packages/coding-agent/src/core/agent-session.ts:843`). Messages persist on `message_end` (`agent-session.ts:505-524`, `:587-589`). Export to JSONL: `exportToJsonl` (`agent-session.ts:3035`).
- **trebol task state**: append-only Pi session entries (`type pi-swarm-task-state`) with `schemaVersion`, `revision`, `savedAt`; replay picks highest revision; future schema versions ignored (`docs/reference/persistence.md:1-12`).
- **trebol audit**: opt-in via `include_audit` on `get` (`docs/reference/persistence.md:12-14`).
- **tern**: TSP `operations.md` covers persistence and flow control (`docs/reference/tern-site/protocol/operations.md`). Not compared in depth.
- **omp**: `.omp/agent`, `.omp/cache`, `.omp/config`, `.omp/plans` paths appear in the bundle (grep-level). Location of session storage unverified.

## Comparison

| Concern | pi RPC (source) | omp (bundle tokens) | tern (TSP) | trebol |
| --- | --- | --- | --- | --- |
| Transport | JSONL stdin/stdout | unverified | pty APC / OSC 877 | Unix socket / serve.Mux (per docs) |
| Request correlation | `id` field | unverified | per-surface node id | task/job ids |
| Shutdown | stdin end, signals, dispose | unverified | surface close sends `x` | daemon lifecycle (`docs/architecture/absurd-pi-integration.md:79`) |
| User prompts | `extension_ui_request/response` | `extension_ui_request` present | forms via `ask` | ask-user TUI + pi.events |
| Default on cancel | `confirm` → false | unverified | n/a | n/a |
| Session persistence | SessionManager file | `.omp/*` paths | n/a | Pi entries journal |

## Open questions

1. Read omp source once `vendor/oh-my-pi` is checked out; confirm RPC field names and default-on-cancel for `confirm`.
2. Reconcile vendor v0.78.1 with installed v1.1.0 dist.
3. Obtain tern-sdk source to verify TSP handshake against the docs mirror.
4. Verify whether trebol's `serve.Mux` shares a schema with pi RPC or diverges.

## Issues

- Filesystem-wide `find /` timed out (90s). Scoped searches were used instead; filed as friction report (github issue #209).
