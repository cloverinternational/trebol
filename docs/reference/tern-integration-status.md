# Tern integration status (2026-10-11)

## Pi (trebol)

### Bash rendering and live output (2026-10-13)

The Tern bridge projects Pi `tool_execution_start/update/end` into keyed TSP
`tool` nodes (`.pi/lib/tern/bridge.ts#TranscriptProjector`, `#bashToolNode`).
The installed OMP sources at
`~/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/tools/bash.ts`
(`describeCall`/`describeResult` in `createShellRenderer`) show the actual
contract: the tool head reads `Bash` (or `Bash · name`), with intent as its
target; the command is a highlighted `code` input in an `omp.run` box, followed
by a `follow`/10-line-preview ANSI output and a `Running`/`Done`/`exit N` foot.
The outer tool uses OMP's borderless `frame: "inline"` (the `omp.run` child
owns the framed appearance). The tool is collapsed while running; its preview
is owned by the child, not the outer tool (`preview: "children"`). The OMP tool wrapper implements
the clock/status/collapse in `@oh-my-pi/pi-tui/src/chat/tool-execution.ts#describeTool`.
The bridge now emits the same node shape and roles for bash (`description`
as the available intent), while leaving other tool families untouched.
Previously bash used a plain `text` child,
put the command in the head and collapsed the completed card without a body
preview. Pi's foreground extension ignored `onUpdate` and
`runSwarmBash` buffered both pipes until close; thus `printf first; sleep 1;
printf second` could not show `first` while the process ran. This is separate
from background Bash's polling preview.

The foreground extension now forwards throttled cumulative output snapshots
in observed stdout/stderr pipe-event order via Pi's tool update callback;
the runner separately keeps the original stdout/stderr streams for the model
envelope. The runner emits on pipe data and
decodes split UTF-8 sequences (`extensions/swarm-bash/extension.ts#registerSwarmBash`,
`.pi/lib/tools/swarm-bash.ts#runSwarmBash`). On completion the bridge retains
the last ordered live snapshot (including its ANSI colors) rather than replacing
it with the model's channel-grouped, ANSI-stripped or truncated XML envelope.
If the tool emitted no update, it displays the decoded final result instead.
A failed Bash call preserves its already-streamed output rather than replacing
it with model-facing error prose.
Tern's native ANSI node follows and previews the last ten visual lines without
dropping the full output. The model still receives its original XML contract.
`bridge.test.ts` checks the TSP running node before end and final
replacement; `swarm-bash-extension-stream.test.ts` checks the registered Pi
tool's update callback before `execute` resolves. `swarm-bash-stream.test.ts`
checks stdout before exit plus stderr, split UTF-8, and cancellation.
A focused live Tern probe used an
isolated tab running the Pi bridge and actual `runSwarmBash` with `printf
FIRST_VISIBLE; sleep 12; printf SECOND_VISIBLE`. At 1791855064, the Tern
`capture --surfaces` output contained `FIRST_VISIBLE` and `Running`; at
1791855068 it still contained `FIRST_VISIBLE` and `Running`. The tab was
launched at 1791855060. This verifies visible output before process completion
without involving a model. The probe script is ignored under
`artifacts/tern-bash-probe/live.mjs`; its 1000 test credits are for isolated
render observation only, not representative of production flow control. A later
probe focused from launch with the actual two-credit limit showed
`FIRST_VISIBLE` and `Running` at 1791855538, five seconds after launch and
before the nine-second command finished; its event log included frame acks.
An additional isolated, focused live Tern tab ran the **registered foreground
Pi Bash extension**, not just the runner. Its `printf FIRST_VISIBLE; perl -e
"select(undef,undef,undef,15)"; printf SECOND_VISIBLE` command was launched at
1791856644; `tern capture --surfaces` showed `FIRST_VISIBLE` plus `Running` at
1791856649 and again at 1791856653, before the delayed second print. This
traces the actual extension `onUpdate` → Pi-style event → TSP bridge path,
though the tab used a minimal fake session in place of a model-driven Pi turn.
The installed OMP source is the parity reference; a side-by-side screenshot
and a model-driven live prompt remain unverified. A live opt-in Pi runner did
start and open its Tern surface, but no provider-driven Bash turn was completed;
the Bash timing evidence comes from the focused registered-extension probe.
A second isolated probe at
the actual two-credit limit, before focusing its window, showed only the
command and `Running` (no output) at 1791855340; logging its incoming events
showed only a hello reply until the window was explicitly focused, at which
point `ack` events resumed. This is a TSP flow-control/visibility constraint:
when no window is drawing the pane, credits cannot advance. It does not prove
output arrives live in an unfocused pane. Earlier full bridge runs had two
unrelated failures (submit test timeout and idle Escape expectation); after
correcting the outdated bridge test assumptions (follow-ups now queue; closing
requires an explicit `none` double-Escape setting), the bridge suite passes.
The running loading node also returned null despite its shimmer contract,
so it has been restored; the full `.pi/test/tern/` suite now passes **207/207**.
The affected four-file Bash suite
(`swarm-bash-render`, `swarm-bash-stream`, `swarm-bash-extension-stream`,
`tern/bridge`) passes **74/74** after the ANSI, stream-order, optional-name,
and pre-abort regressions. The combined Tern and affected Bash suite passes **249/249**
across 15 files (the four-file count includes one overlapping bridge file).

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

### @-mentions in the Tern composer (2026-10-13)

Typed `@path` tokens are resolved when a plain prompt is sent. The grammar
follows OMP's `utils/file-mentions.ts`: a mention starts at the beginning or
after whitespace/opening punctuation, bare `@path` runs to whitespace or the
next `@` with trailing punctuation trimmed, and `@"path with spaces"` /
`@'path'` are quoted. Parsing is `extractMentions` in
`.pi/lib/tern/mentions.ts`; line ranges (`path:N-M`) are **not** supported and
such a token is treated as a literal path. Resolution is exact against the
session cwd (`resolveMention`, `.pi/lib/tern/mentions.ts`): no fuzzy matching,
so ambiguity cannot arise. A missing target stays as plain prose and is
reported as `not found`. A directory expands to a non-recursive listing of up
to 500 entries. Escapes are detected after `realpath` on both the root and the
target, so `..` and symlinks that leave the root are classified `outside` and
never read (`.pi/lib/tern/mentions.ts`, `resolveMention`). Limits:
`MENTION_LIMITS` allows 20 mentions per prompt, 200 KB per file, and 500
directory entries; binary files (a NUL in the first 8 KB) and oversize files
are skipped with a notice. Expansion appends `<file path="...">` /
`<directory path="...">` blocks in a `<mentions>` wrapper after the typed text
(`expandMentions`). The bridge sends the expanded text through
`PiTernBridge.#withMentions` on the idle path and the follow-up path, while
the transcript keeps what the user typed (`.pi/lib/tern/bridge.ts`, lines
1224, 1241, 1261). Typing an `@` token opens a workspace file picker in the
composer. Pi's own `@` provider shells out to `fd`, which is not installed on
this machine, so it returned no suggestions and the picker stayed empty. The
picker uses `suggestMentions` and `workspacePaths` in
`.pi/lib/tern/mentions.ts` (at most 5000 entries, depth 8, skipping `.git`,
`node_modules`, `dist`, `build`, `.next`, `coverage`, and not following
symlinks). `mentionToken` decides when a token is open, and
`autocomplete.ts#refresh` and `#apply` use it. Enter applies the selection as
`@path ` and leaves the draft for a second Enter to send.

Verification: `node --experimental-strip-types tools/e2e/tern-mentions.mjs`
runs a real Pi SDK session with a loopback scripted provider. It drives the
real `PiTernBridge.submit` and the keystroke path (`appendDraft` for `@notes`,
`submitDraft` to apply, `submitDraft` to send). Its last run printed
`PASS tern @mentions: attached files reach the provider; escape blocked`, and
exited 0. The request body contained `ALPHA_NOTE_CONTENT` (bare `@notes.txt`)
and `BETA_PLAN_CONTENT` (quoted `@"docs/my plan.md"`), and did not contain
`OUTSIDE_SECRET_CONTENT` for a `..` path or a symlink pointing outside. The
outside notice appears in the rendered output. Existing `npx vitest run
.pi/test/tern/` passed **207/207** across 12 files, and `tsc --noEmit --strict`
on `bridge.ts`, `autocomplete.ts` and `mentions.ts` reported 0 errors. No unit
tests were added, per the testing contract.

Not established: a live Tern composer check. Runner panes launched through
`tern new session` and `tern -e` stayed on Tern's footer and never drew the
composer, so the keystroke path was verified in-process, not in a visible Tern
window. The picker's on-screen rendering, a live model reply using the
attachments, and OMP-style layout are unverified. Missing-target and directory
expansion have no test. Probe sessions were closed afterward.


### Composer editing: caret, selection, word delete, undo (2026-10-13)

The composer draft is owned by `DraftEditor` in `.pi/lib/tern/draft-edit.ts`
(caret, selection anchor, word motion, undo with typed-run coalescing, 200-step
limit). The bridge's `#draft` accessor reads and writes it, so existing callers
are unchanged. Keys (`.pi/lib/tern/keys.ts`): Left/Right move the caret (they
still move ask-dialog tabs when a dialog is open, via `moveTabOrCursor`);
Alt+Left/Right move by word; Shift+Left/Right extend the selection; Ctrl+A or
Cmd+A selects all; Ctrl+Z or Cmd+Z undoes; Alt+Backspace deletes the word before
the caret. Typing and Backspace replace a selection. Undo restores text with the
caret and no selection. Shift+Tab still maps to a tab move, so in the composer
it moves the caret left.

Verification: `node --experimental-strip-types tools/e2e/tern-draft-editing.mjs`
drives raw key bytes through `keyEffect` into a real Pi session and a real
`PiTernBridge`, then checks the drafts and the provider request. It printed
`PASS tern draft editing: caret, selection, word delete, and undo drive the composer`.
`tern-mentions.mjs` still passes, `npx vitest run .pi/test/tern/` passes
207/207, and `tsc --noEmit --strict` reports 0 errors.

Not established: on-screen rendering of the selection. The composer node now
passes `cursor` and `selection` to the editor node. Whether Tern draws the
selection highlight has not been observed, and no visible Tern window was
captured.

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

### /resume in Tern (replaces `pi -r`)

- Runner: `.pi/lib/tern/run.ts` now runs through `AgentSessionRuntime`. After each replacement, `setRebindSession` rebinds the bridge (`PiTernBridge.rebind`) and extension UI; command-context `switchSession` routes to the runtime.
- Command: `/resume` (Tern builtin, `commands.ts` TERN_BUILTINS, forwarded by `bridge.ts` #runBuiltin to the `/tern-resume` extension command in `extensions/tern-resume/extension.ts`). Refused while busy, like other builtins. It lists other sessions in this project through `ctx.ui.select` (a native Tern dialog) and switches with `.pi/lib/tern/session-resume.ts`. It does not use `-r`, so there is no flag conflict.
- Verified: `node tools/e2e/tern-resume-command.mjs` PASS (cancel keeps the session and reports "Resume cancelled"; selection switches the live session and the transcript). `tools/e2e/tern-session-resume.mjs` and `tools/e2e/tern-mentions.mjs` also PASS.
- Not verified: a live Tern window selecting a session and showing the transcript change; the cancel path in a real Tern dialog. Both need a human-driven Tern window.
- Known gap: the runtime's `beforeSessionInvalidate` hook is not used, so a Tern dialog open during a switch is not explicitly torn down.
- Responsiveness: `/resume` prints "Loading sessions…" as soon as it is submitted (`bridge.ts` #runBuiltin). The picker opens from the 10 newest sessions for this cwd (`extensions/tern-resume/extension.ts` firstPage, about 130 ms on the 44-session workspace history). The full `SessionManager.list` (about 950 ms here) runs only when the user picks "Show all sessions".
