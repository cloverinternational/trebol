# Per-chat Hoja and Claw modes across /reload

Date: 2026-10-21. Scope: `extensions/hoja-mode`, `extensions/claw`, `.pi/lib/runtime/session-mode-entry.ts`, `.pi/lib/claw/mode.ts`.

## Root cause

- Claw mode lived only in process globals (`Symbol.for("pi-swarm-claw-mode")` via `.pi/lib/claw/mode.ts`). Pi's `/reload` fires `session_shutdown` on the old instance first; the Claw handler called `deactivate()`, which cleared the global and restored the pre-Claw tool set. The new instance's `session_start` only hid orchestrator tools. Nothing re-read a per-chat record, so Claw came back off.
- Hoja mode was an instance-local `enabled` flag reset to `true` on every `session_start`. `/hoja off` was therefore lost on reload, and nothing was persisted.

## Fix

- `/claw on` and `/claw off` persist `claw-mode` (`{on, savedTools}` on; `{on:false}` off) with `pi.appendEntry`. `/hoja on|off` persist `hoja-mode` (`{enabled}`).
- On `session_start`, each extension reads the newest matching custom entry on `ctx.sessionManager.getBranch()` (`latestSessionModeEntry`). Claw restores from the persisted `savedTools` and does not call the daemon ensure, rename tabs or write store control.
- Shutdown still restores the pre-Claw tool set but does not persist, so the next `session_start` decides the state.
- Inbox pump runs and claims ownership only while this chat's Claw mode is on. Dedupe still uses the delivered-ids in the branch.
- Store control (daemon, triggers) remains separate from per-chat mode.

## Session semantics

| Event | Result |
| --- | --- |
| `/reload` same chat | restores the chat's last saved mode |
| resume another chat | that chat's own entries; global routing cleared on shutdown |
| new chat | no entries: Hoja on, Claw off, no inbox ownership |
| fork | inherits entries on the copied branch up to the fork point (transcript semantics) |
| `/off` | persists off; survives reload |

## Tests

- `.pi/test/claw/session-mode-restore.test.ts` (8): same-session reload on, ensure count and store control unchanged, off-then-reload stays off with the exact pre-Claw set, restore from persisted set, new chat isolation, session switch, repeated reloads with one entry and one daemon ensure, combined Hoja+Claw on, combined Hoja off with Claw on.
- `.pi/test/tools/hoja-mode-restore.test.ts` (3): new chat default on, off persists through reload and on-after-off persists, resume of an off chat stays off.
- Existing `.pi/test/claw/routing.test.ts`, `orchestrator-tab.test.ts`, `.pi/test/tools/hoja-mode.test.ts` still pass.
- Targeted run: `npx vitest run .pi/test/claw .pi/test/tools/hoja-mode.test.ts .pi/test/tools/hoja-mode-restore.test.ts` -> 8 files, 116 tests passed.
- Typecheck: `tsc --noEmit` (strict, NodeNext) over the changed extension, helper and new test files: 0 diagnostics.
- Relevant wider run `.pi/test/claw .pi/test/tools/hoja-mode* .pi/test/runtime`: 22 of 23 files pass. The one failure, `.pi/test/runtime/session-hook-dispatch.test.ts` "preserves same-group handlers and isolates sessions/shutdown" (`expected "spy" to be called 1 times`), imports only `.pi/lib/runtime/hook-state.ts`, which this change does not touch; it is unrelated and not investigated further here.

## Real E2E (owned scratch tabs, PI_TERN_UI=0, `-e` hoja-mode and claw entrypoints)

Workspace: `/tmp/claw-reload-e2e/scratch-a` (owned). Sessions: `/tmp/claw-reload-e2e/sessions-b`, `sessions-c`. The user's tabs and daemons were not touched. Tabs closed at the end.

Evidence is the session JSONL, not model self-report. Pi writes a `system` message `toolsAdded/toolsRemoved` diff when the active tool set changes at turn start, so a diff only appears on the next prompt.

| Step | Direct evidence |
| --- | --- |
| `/hoja on`, `/claw on`, prompt | entries `hoja-mode {enabled:true}`, `claw-mode {on:true, savedTools}`; diff adds 6 `claw_*`, `Agent`; `Subagent` absent |
| `/reload`, prompt | no new diff: routed set unchanged after reload |
| owner after reload | `orchestrator.json` owner is the same session id; one `daemon-main` process (pid unchanged) |
| `/claw off`, prompt | entry `claw-mode {on:false}`; diff removes the 6 `claw_*` and `Agent`, re-adds `Subagent` and others |
| `/reload`, prompt | no new diff: stays off |
| `/hoja off`, `/reload` | entry `hoja-mode {enabled:false}` persisted |
| unrelated new session (`sessions-c`) | no `hoja-mode` or `claw-mode` entries; diff has no `claw_*`, `Subagent` present |

Limitations seen in E2E:

- `/hoja status` after reload produced no visible notification in the pane, so the live Hoja state after reload is **unknown** from E2E. Persistence is verified from the transcript entry, and the restore path is covered by unit tests.
- A `/reload` with no prior user or assistant message: Pi writes the session file only once a conversation exists (`_persist`/`_hasConversation` in `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`). Mode entries set in a brand-new chat are in memory until the first prompt, so quitting Pi before the first prompt loses them. Not fixed here.
- After `/claw off` the daemon exits after its idle window (documented in `README.md`); the inbox owner field still names the old session but delivery is gated by the chat's Claw mode.
- Fork semantics follow the copied transcript branch; not exercised live.
- Not covered: trigger firing while on/off, worker spawn, and inbox delivery into a restored chat.

No commit or push. No Hoja issues were created.
