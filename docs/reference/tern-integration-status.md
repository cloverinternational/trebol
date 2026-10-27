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

### Session durability: resume only after the machine went down (2026-10-27)

Four "Tern went away" cases, four mechanisms — and only the last is a resume:

| Event | Process | What Tern does | Next `pi` here |
| --- | --- | --- | --- |
| Window closed | keeps running | daemon keeps the pty; reattach redraws (`protocol/operations.md#Persistence`) | n/a (same process) |
| Pane closed, `pi` quit, ctrl-c | dies (SIGHUP → `restore()` → `exit(128)`) | live surfaces close with `keep:true` | **new conversation** |
| `/new` | survives | runtime replaces the session | **new conversation** |
| Machine crash / reboot | dies | restored panes start a **new login shell** (`concepts/lifecycle.md#Daemon restart and upgrade`); pane ids persist in `daemon.state` (`{"id":…,"cwd":…,"command":null}`), so `TERN_PANE` still matches | **reopens that pane's session** |

`.pi/lib/tern/startup-session.ts` records `{sessionFile, pid, cwd, boot}` per `TERN_PANE` in
`~/.pi/agent/tern-panes.json`; `bootGeneration(now, os.uptime())` identifies the boot to the
minute. `chooseStartupSession` opens the recorded session only when the record's boot is an earlier
one, the file exists and no live runner owns it; `same-boot`, `owner-alive`, `missing`,
`no-candidate` and `PI_TERN_FRESH`/`PI_TERN_RESUME=0` all start new. Records without a boot
generation are discarded, and the "most recent session for this directory" fallback was removed —
it was what made a closed pane come back to a conversation the user had finished with.

`/new` runs through Pi's runtime (new `newSession` bridge option, wired to `runtime.newSession()`),
is listed as a Tern builtin, and the rebound session is recorded, so the pane leaves the old
conversation behind immediately. `bridge.start()` seeds the transcript from `getBranch()`, so a
reopened pane draws its history on the first frame.

omp's comparable logic, read out of the installed bundle
(`~/Library/Application Support/Tern/omp/bin/omp`): a settings entry `autoResume` (boolean,
**default false**, "Automatically resume the most recent session in the current directory"),
`-c/--continue`, `-r/--resume`, and `--restore`, which resumes *and* continues the interrupted turn
and its subagents. Pi now matches the first three and is stricter about *when*: omp's `autoResume`
is cwd-scoped, this is boot-scoped. Re-driving an interrupted turn is deliberately not implemented;
`rebind()` marks interrupted tool calls as cancelled.

Verification: `npx vitest run .pi/test/tern` passes (385 tests at the time of writing, 13 new in
`startup-session.test.ts`, 3 `/new` cases in `commands.test.ts`, 2 resumed-session cases in
`dock.test.ts`) and `node --experimental-strip-types tools/e2e/tern-durable-resume.mjs` prints
`PASS tern durable resume: post-boot resume renders, same-boot and forgotten records start over, a
live owner is never doubled`. Live in Tern pane `588706872295426` (`/tmp/tern-fresh-live/proj`):
first start wrote `pid 38668`; killing it and restarting `pi` in the same boot opened a **different**
session file (`17-24-10` → `17-24-19`); `/new` moved the record to `17-24-25` and the trace shows
`Started a new session`; a record rewritten as pre-boot (`boot − 1`, session `17-27-21`) was
reopened by `pid 74306`, and that runner's first frame was
`["msg-0523ffda","pi.user","","LIVE_PREBOOT_MARKER"]`.

Not established: pixels. The restored row is read from the dogfooding UI trace
(`~/.pi/agent/tern-trace/`), not from a Tern screenshot; `tern read` returns grid text, which shows
the pane's shells but not the native `main` region. A Tern daemon restart **without** a reboot (app
crash, upgrade) is not a resume either: panes come back as shells and `pi` starts fresh; use
`/resume` there.

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

### Style and geometry lint (`tools/tern/style-lint.mjs`)

The oracle is Tern, not a reading of our CSS. `npm run lint:tern` starts a headless `tern serve --control`,
loads the three sheets the bridge registers (composer, work, startup) and replays real recorded Pi sessions
(`.pi/test/tern/fixtures/turn-work/*.events.jsonl`) through the real `PiTernBridge`. Each state is played at
480/800/1100/1400 px; `tree` and `dump` then report every painted box, its computed type and its parent path.

- Rules: `spill-region` (a box leaves its surface), `spill-parent` (a box exceeds its parent), `clipped-line`
  (text in a box shorter than a line), `invisible`, `type-scale` (our roles outside 9.5/10/10.5/11/13 px),
  `space-scale`, `selector-subset`, `length-unit`, `sheet-parse` (Tern's own parser verdict), `fold-reset`
  (a stateful node deleted and re-added, which drops the host's fold/focus), `dock-edges`.
- `tools/tern/style-lint.baseline` records measurements we accept, with the tolerance and the reason. Today
  that is only Tern's own sheet bleed (`.sf-tool-head` 6px per side, `.sf-ck-ph` 2px, the spinner 0.7px). Any
  other excess fails the run, and the summary reports how many measurements the baseline absorbed.
- `npm run lint:tern:self-test` seeds each defect (an invalid `:has()` rule, an 8px font, a 13px margin, a
  3000px box) and fails if a rule stays silent, so a green run means something.
- Found and fixed: the work card's Activity chip was derived from "a step is running right now", so every step
  boundary deleted and re-added it (`fold-reset`, 18 errors before the change in `bridge.ts`, 0 after).
- Limits: it measures painted geometry, so native host folds, hover popovers and focus rings are invisible to
  it; states come from recorded sessions, not from live keystrokes; and `tree` omits elements scrolled out of
  view. None of those are claimed as covered.
