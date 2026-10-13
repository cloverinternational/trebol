# Tern Pi rendered regression (in progress)

## Baseline

The user's live dogfood report identifies four missing or broken areas:
half-width input, absent Pi-Swarm footer, absent top task/questions, and no
loading indication. Earlier TSP node tests did not check pixels or extension
UI delivery.

An isolated headless Tern 0.6.2 server (`tern serve --control
/tmp/trebol-ui-probe.sock`) launched the current `node --experimental-strip-types
.pi/lib/tern/run.ts` in a 1280×800 viewport and captured PNG/layout at
1280×800, 800×650 and 480×600. The 800px capture showed the composer card,
input, context meter and status bar, **but no top task widget**. In that
controlled pane `dump` measured `[data-role='pi.editor']` at width 1224px,
`[data-role='pi.composer.line']` at 1196px and `.sf-editor` at 1196px within
the 1280px viewport. Thus the measured idle field in this fixture was nearly
full width; it did **not** reproduce the user's half-width typing state.
The original Pi composer stylesheet lacked OMP's direct-child `flex: 1`
rule; the installed Tern binary has
`[data-role='omp.composer.line'] > .sf-editor { flex: 1; }`. The Pi-scoped
analogue was added in `.pi/lib/tern/composer-style.ts`. A long draft was
sent in a normal 143×43 pane, but `tern capture --surfaces` reports main only
and cannot prove the typed field width. A controlled screenshot **after**
typing and resize remains necessary.

Native Pi's current-session capture showed `trebol / main` with `sol WORKING`,
context gauge, output/active time, and the `Autogen … · Skill …` provider
row. It also showed a `Tasks … done /tasks` block with a focused task and
acceptance questions above the input. The TSP frontend's separate
`createAgentSession()` process has not bound an extension UI context: the
installed SDK runner defaults `setWidget`/`setFooter`/`setHeader` and working
indicator methods to no-op (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:132-163`). The canonical task widget is
registered through `ctx.ui.setWidget("swarm-tasks", factory)` in
`packages/tools/taskmanage/src/task-manage.ts:1090-1105`, and the footer
through `ctx.ui.setFooter` in
`extensions/conversation-metrics/extension.ts:273-277`. That is the source
explanation for absent top tasks/questions and the native footer; a TSP-only
approximation of session metrics is not the Pi-Swarm footer.

## Results

The Pi-scoped composer stylesheet now includes the installed OMP rule
`[data-role='pi.composer.line'] > .sf-editor { flex: 1; min-width: 0; }`.
In an isolated Tern controlled pane, after TSP startup a typed 88-character
draft measured `.sf-editor` at 396px in a 480px viewport and 716px in an
800px viewport; screenshots `typing-480.png` and `typing-800.png` under
`/tmp/trebol-ui-final/serve/` show wrapping rather than half-width clipping.
The user-reported half-width state was not independently reproduced in this
fixture before correction, so the measured improvement is the explicit
missing OMP flex rule and full-width post-fix geometry, not a before/after
half-width screenshot.

The live pending frame (`pending-120.png`) showed a `Waiting for agent`
spinner in the dock and a running state; after a harmless turn the controlled
pane showed `LOADING_VISIBLE_OK`, `Context 8%`, five actual output tokens,
`0m 01s active`, `idle`, and no spinner (`loading-finished.png`). These are
observed TSP values from that isolated session, not the native Pi session's
`123.8k` tokens or Autogen skill state. `loading.ts` and the bridge clear
the indicator on `agent_end`/`agent_settled`, abort, failure and close;
terminal cases have focused tests.

The canonical TaskManager snapshot projector (`.pi/lib/tern/task-view.ts`)
uses `TaskManager.rehydrate` from the compiled package artifact because the
headless Node 22 `--experimental-strip-types` runner cannot load its source
TypeScript parameter properties. A test verifies a focused task and question
are direct children of `dock` above `composer-col`; another verifies no
fabricated task when the active session has no task journal. The earlier
controlled pane did contain a focused task node in **main**, but it was at
negative Y and invisible while scrolled to the tail. The node was moved to
the dock. A fresh TSP `createAgentSession({cwd})` has a **new session ID** and
no task snapshots, whereas `SessionManager.continueRecent(cwd)` on this host
returned a different prior session with 684 task snapshots. We did not load
that other process's recent session just to populate the UI; task/questions
must come from the TSP process's own active journal. A post-change live
populated-task screenshot remains unverified, although the replay test and
isolated in-memory journal projection passed.

The TSP dock footer now has a separate read-only row composition
(`footer-view.ts`) based on its active session plus available process-wide
`pi-swarm-footer-segments` providers. Extension binding in `run.ts` uses
`mode:'tui'` **without** a custom UI context: installed Pi's
`ExtensionRunner.hasUI()` remained false in a direct probe, so confirm/select
are still denied. It registers the Autogen provider on session start;
providers returning undefined stay hidden. A live, stable TSP screenshot of
the new footer row and its conditional segments is still needed. Do not
represent this as the native `ctx.ui.setFooter` component: that factory is
not bound to this separate TSP renderer. The normal Pi-Swarm footer remains
owned by `extensions/conversation-metrics/extension.ts` in native Pi.

Keep confirmations default-deny; autonomous answers are not user consent.
Rollback the local TSP dogfood route with `pi -nt` (shell only) or
`PI_TERN_UI=0 pi`; the native Pi TUI is unchanged.

## Components and typography (Tern 0.6.2)

The TSP frontend cannot instantiate the native Pi TUI `setWidget`/`setFooter`
factories or arbitrary GPUI widgets. Tern's documented TSP `card`, `text`,
`status`, `seg`, and `editor` nodes are instead rendered by Tern's own UI.
`docs/reference/tern-site/elements/layout.md` documents the card head/body
and native status chip; `elements/chrome.md` documents status/seg fitting;
`styles/variables.md` defines `--tv-font` and `--sf-fs` for the surface font.
The task/questions region (`task-top`, role `pi.tasks`) is a compact,
opaque (`--card`) column using session-backed canonical TaskManager
snapshots: an uppercase summary line, an accent focus line, warn/ok-coloured
acceptance questions and the next task, at 10.5px. It has no status chip.
Every task sits in a `pi.tasks.pop` popover above it, hidden by default and
shown only by the stylesheet rule `[data-role='pi.tasks']:hover`; hover is
Tern view state, so show/hide needs no program round-trip. Clicking a task
appends `task #N` to the draft without sending; right-click folds the
questions. It is read-only: no task click means an answer or consent.
The footer is TSP status/seg rows using only available session metrics and
conditional provider output. It is **not** the native Pi footer factory.

## Top and footer rendered observations

A fresh `node --experimental-strip-types .pi/lib/tern/run.ts` in an isolated
`tern serve` pane showed a real `pi.footer` at 800×650: `trebol`, active
model/provider, `IDLE`, `Context 0%`, and `Autogen 0/5`. The footer contained
three `.sf-status.transparent` rows, each 744×24 CSS px in a 800px viewport;
the `.sf-editor` measured 716×28. Screenshot:
`/tmp/trebol-gpui-verify/serve/gpui-idle.png`. The fresh active session had
no task snapshot, so no task block was claimed for it.

An **isolated in-memory fixture** using a single canonical task snapshot,
not another running Pi session's journal, rendered the `pi.tasks` card in a
separate controlled pane at 480×600 and 800×650. Measured task card rects:
`[28,306,424,126]` and `[28,372,744,110]` CSS px, respectively. The long
question visibly wrapped at both sizes without being clipped; the card stayed
above the full-width composer. Screenshots:
`/tmp/trebol-gpui-fixture/serve/fixture-480.png` and `fixture-800.png`.
This establishes rendered component behavior for a populated fixture, **not**
that the ordinary new session automatically inherits the native Pi task list.

## Typography

At 800×650, Tern `dump` reported the task card, footer, and `.sf-editor` as
13px, weight 400, with the Tern terminal font stack (the editor stack appends
its own fallback). Task focus is intentionally weight 600; the TSP card's head
and status badge retain native Tern hierarchy. The 480×600 screenshot shows
the same face and readable wrapping of two questions. Status strips have
Tern's own 24px line height and native hairlines; their structure is not
identical to native Pi's footer. Captures and node rectangles were checked
independently; no pixel-identical OMP parity is asserted.

## Live reload and dialog boundary

`/reload` is handled locally in the TSP bridge, only while idle with no open
question. The SDK's `AgentSession.reload()` reloads active settings/extensions,
skills, prompts and related resources without adopting a different session;
the TSP `s` message replaces the named `composer` sheet with the CSS read
from disk. It also attempts `tern plugin reload` with the documented 60-second
CLI timeout, reporting failure separately rather than claiming plugin success.
Linked Tern plugins have their own file watcher. **Node modules already loaded
in this runner, including the TSP bridge, need a pane restart to pick up
JavaScript changes**; `/reload` does not pretend to hot-swap them.

In an actual isolated Tern pane, `/reload` reported Pi resources and Tern
daemon plugins reloaded. For an observable stylesheet test, a temporary
`rgb(250,239,221)` footer fill was added on disk, then the same running pane
executed `/reload`: Tern `dump` reported the visible footer's background as
`rgb(250, 239, 221)`; screenshot at
`/tmp/trebol-reload-check/serve/hot-style-final.png`. The temporary rule was
removed and another `/reload` measured the original transparent background.
No persistent test color remains in the source.

The existing `ask_user_question` extension has a native `ctx.ui.custom`
interface and a validated same-process remote-ask event contract. The TSP
runner now shares an event bus with a modal Tern overlay and preserves
`ctx.hasUI() === false`; only explicit user answer/cancel actions may emit a
remote submit. This is not a generic approval UI. A controlled fixture
rendered a native TSP `overlay` with two styled choice rows, submit and cancel
at 800×650 (`/tmp/trebol-ask-final/serve/styled-ask.png`). In a live pane
driven through the runner's real key path (StdinBuffer → `keyEffect` → bridge)
against the real remote-ask runtime:

- Enter with nothing selected sent nothing and showed "Answer required: Scope".
- `2` selected Wide (`(•)`, no submit); Enter then delivered
  `{"kind":"answer","answers":{"scope":{"values":["wide"]}},"mode":"submit"}`
  and the overlay closed on flow completion.
- `2` then Escape delivered `{"kind":"cancel"}`; the overlay closed and the pane
  stayed open.

The Escape probe exposed a runner bug: `splitInput` held a lone ESC as a
possible `ESC _tsp;` prefix and never released it, so Escape never reached
the bridge. `run.ts` now flushes a short held prefix as keys after 50 ms
with no continuation.

Not yet verified: freeform text answers (rendered as "needs terminal UI"),
multi-question keyboard navigation, and a model-triggered `ask_user_question`
in a real Pi session. Abort/timeout are covered by extension tests and
resolve as cancelled, never as an answer.

## Composer: OMP's roles, Tern's built-in sheets (task 43)

- Pi's dock is `composer-view.ts`, a node-for-node port of OMP's `describeLayout`/`#S`/`describeComposerFacts`
  (OMP 18.9.1): `omp.editor` col → `omp.composer.context` meter → `omp.composer.line` (editor, placeholder
  "What are we cooking?") → `omp.composer.bar` (model chip with effort glyph, extras status with git fact,
  usage, send kbd / Stop). Tern's built-in `omp-composer.css` + `omp-chat-reader.css` key on these roles and the
  host adds `.sf-place` (folder) and `.sf-caption` (folded name) around them, so Pi gets OMP's glass card,
  hairline meter, chips, fold and caption with no Pi CSS. The scoped `pi.*` composer sheet and the
  `tern-plugins/pi-composer` fold plugin were removed (program `s` sheets cannot see `.sf-unfocused`).
- Data is Pi's: context tokens/window (`getContextUsage`), compaction mark at (window − reserveTokens)/window
  when enabled, model display name (OMP drops "Claude "), thinking level when `supportsThinking()`, git
  `status --porcelain -b` of Pi's cwd, session cost (`getSessionStats().cost`). Omitted (no Pi source): tok/s,
  subagent focus crumbs, shell mode, compaction speculation mark. Fact clicks state the fact in the transcript.
- Verified in a real window (`tern --control`), OMP and Pi side by side at 1280×800: focused and unfocused,
  42 dock elements each, all rects identical except data-driven ones (fill %, compaction mark position,
  caption name width) and span colours (OMP sends its `titanium` theme via TSP `t`; Pi sends none).

## Extension prompts: native Tern UI context (task 44, option B)

`.pi/lib/tern/ext-ui.ts` (`TernExtensionUI`) is bound as Pi's `uiContext` in `run.ts`, so `hasUI` is true and
every extension command's prompts work with no per-command code:

- `select` / `confirm` → modal `overlay` with a `list` (↑/↓, digits, click, double-click, Enter, Esc). Confirm is
  `Yes`/`No`, true only on explicit Yes.
- `input` / `editor` → focused `input` / `editor` field (Shift+Enter newline in editor).
- `notify` → transcript system line; plain-text `setWidget` → muted text above/below the composer.
- `setEditorText` / `getEditorText` / `pasteToEditor` → the composer draft.
- Prompts queue; abort signal, timeout, Esc and pane close resolve as Pi's cancel (undefined / false).
- `custom` runs the factory; if a native Tern flow (the ask dialog) starts it waits for `done`, otherwise it
  disposes the panel and says it needs `pi -nt`. Status/footer/header/component factories are no-ops.

Live (1280×800): `/swarm-thinking` rendered the overlay, ↓↓ moved to Low, Esc cancelled, ↓×4 Enter applied
"Thinking level: high."; `/tasks` (TUI-only panel) printed the `pi -nt` notice. Not covered: Pi builtins
that require terminal-only panels (`/settings`, `/tree`, …) still report unavailable — that is option A/C.

## Slash-command autocomplete (task 45)

The old `/commands` picker is replaced with a caret-anchored `omp.autocomplete` overlay containing an
`omp.select` column and a 10-line list. Pi's `CombinedAutocompleteProvider` supplies fuzzy-filtered commands
and real argument completions from extension commands, scoped/available models, and thinking levels. Entries
carry OMP's icons, prefix marks, muted descriptions, live model/thinking value chips and Pi source tags. Tab
completes a command name with a space and opens its argument suggestions when available; repeated Tab can
advance through further subcommand levels supplied by Pi, Tab/Enter can apply an argument, ↑/↓ change the
selection (with a nearest reveal), Esc dismisses the list, and selection hints appear as an editor ghost suffix. Pi
builtins keep OMP's ordinary row treatment even when their handler needs Pi's terminal UI; submitting those
commands reports the explicit `pi -nt` requirement. Supported builtins are routed to
the live Pi session, never sent to the model.

Live 1280×800 observations: `/` showed the command list; `/thi` filtered to thinking and the project
extension; Tab opened the actual thinking levels; ↓ Enter inserted `minimal`, then Enter set the level;
`/model gpt` showed available model ids. Screenshots under `target/shots/tern/live/pi-{slash,thi,thi-tab2,thi-enter,model-arg4}.png`.
The command list and Tab-to-arguments match OMP's visible layout. The `/model` list originally triggered
Tern virtual rows above 200 suggestions, with 78.5px pitch instead of OMP's 46.8px. The autocomplete now
keeps **all** real suggestions for keyboard selection and completion, mounting a moving window of at most
100 rows to avoid Tern's virtual-row threshold. Live `/model gpt` measured 46.8px pitch; 110 Down presses
reached a later selection with the same pitch and Tab inserted `/model clover-plexus/terra`. Screenshots:
`target/shots/tern/live/pi-model-windowed{,-110,-110-tab}.png`. Full 1:1 parity remains qualified:
OMP-only `modelpreset` and hints without a Pi equivalent are not invented; the moving-window DOM has
different offscreen nodes from OMP, though the tested rendering and access to later completions agree.

## Hover task popover (headless check)

An isolated five-task fixture (`/tmp/trebol-taskhover/fixture.mjs`) in
`tern serve` at 800×650 measured `pi.tasks.focus` at 10.5px, weight 600.
At idle `pi.tasks.pop` was hidden. After `hover [data-role='pi.tasks.next']`
it was `visible: true` at `[29,278,743,140]`, with background
`rgb(255, 255, 255)` and opacity 1. After `move 400 100` it was
`visible: false`. `click [data-role='pi.tasks.next']` put `task #4` into
the editor. The screenshots are `idle.png`, `hover.png` and `unhover.png`
under `/tmp/trebol-taskhover/out/serve/`.
