# Changelog

Release metadata is kept in `package.json`, `update-manifest.json`, and this file together.

## [Unreleased]

### Added

- Hoja read tools that can answer date questions (#352): `hoja_list` and `hoja_get` still send only two fixed GraphQL
  `query` documents and never a mutation, so both stay read-only. `hoja_list` now returns `createdAt` and `updatedAt`
  for every issue and takes server-side filters — `state` (`open` by default, `closed` for Done and Canceled, `all`, a
  workflow state type or an exact state name), `assignee`, `project`, `team`, `updatedSince`/`updatedBefore` and
  `createdSince`/`createdBefore` (ISO dates, a bare `YYYY-MM-DD` meaning UTC midnight) and `limit` (default 100, max
  200) — plus the `appliedFilter` it used, so a surprising result is visible instead of guessed. One extra sentinel row
  is still read to report `truncated` honestly. `hoja_get` no longer scans the 250 most recent issues, which made older
  issues unreachable once the team passed 250 closed ones: it looks the issue up server-side by `identifier`
  (`filter: { identifier: { eq } }`, verified by introspection) and returns the description, `createdAt`, `updatedAt`,
  priority, URL, state name and type, team, assignee, project and the most recent comments with author, date and body
  (long bodies truncated, count selectable 1–50). Filters travel only as typed `IssueFilter` variables, so no caller
  text can ever become GraphQL; `hoja-mode.test.ts` proves it for every document, parameter and a mutation-shaped
  input. Descriptions moved into `.pi/lib/tools/swarm-hoja.contract.ts`, which the extension now imports so the
  model-facing text cannot drift. See `extensions/hoja-mode/extension.ts`.
- Claw keep-open and resume (#346): a run can now outlive its own completion, so a human and the agent can keep working
  in the same conversation. `claw_spawn` and the routed `Agent` tool take an explicit per-run `keepOpen` (default off),
  recorded on the run before any side effect, so the supervisor's single close point skips that tab across daemon
  restarts and every tick while events, the goal and the Hoja outbox keep being reconciled; a kept tab is not
  supervision work, so it cannot hold the daemon alive. `claw_set_keep {run_id, keep}` releases it and `claw_close
  {run_id}` closes it now (both clear a spent `tab-close` budget so the release always takes effect). `claw_resume
  {run_id}` relaunches a worker into the run's **recorded session file** — `pi --name <label> --session <path>`, the flag
  the installed CLI documents as "use specific session file" and resolves through `SessionManager.open`, appending to
  that file — with no positional prompt, so the task is never re-executed: same run, same Hoja issue, no second issue or
  duplicate run, and it works for a dead worker, a closed tab, a completed run and after a daemon restart (the stale pid
  is cleared first). Resume refuses clearly when the worker is alive, when an active run's worker cannot be *proven*
  gone, when a resume is already in flight, when the session file is missing or gone, when the Hoja issue was deleted,
  and when its retry budget is spent (3 attempts in the shared remedy ledger, one `run_budget_spent` with the reason).
  Status and listing expose `keepOpen`, `resumable` and the reason when not, and a resume emits a normal `resumed` run
  event. With the always-on goal: keep-open never re-arms, extends or pauses a goal (a terminal run's goal ends exactly
  once and its spec is withdrawn), while a resume arms the next *generation* of the same goal — same condition, one run
  record, the ended generation kept in `goal.history`, exactly one spec written before the tab opens, and a new
  generation source so the goal extension's per-source tombstone (which stops a restart from resurrecting a finished
  loop) does not silently block a deliberate resume; a failed resume rolls the re-arm back. See
  `docs/claw/README.md` and `tools/claw/mutation-check.mjs` (14 mutations, all killed).
- Tern turn card as a data projection: one native `tool` head per tool call, nested in the card in call order, carrying
  the verb, a typed target (`command`/`path`/`pattern`), status, live `age` while running and `took` once settled,
  `exit`, `note` and `intent`; the card head is the turn itself with its own clock and a `warning` badge for a
  recovered failure; a running step is open over a bounded live window and a settled one folds to its head;
  `apply_patch` draws per-file `diff` nodes instead of a status word; subagents are `agent` rows and a TaskManage batch
  is one `checklist`. Tern draws and clocks the parts that change every second, so the bridge never re-renders on a
  timer. `diffChildren` now matches children by id and reorders with `move` ops, so a settling step no longer deletes
  and re-adds its siblings (which discarded Tern's per-node fold, scroll and highlight state), and the spacing rules
  moved into `.pi/lib/tern/work-style.ts`. See `AGENTS.md` §Live work rendering contract and
  `node tools/e2e/tern-live-work-demo.mjs` (renders one scripted turn in its own pane).

### Fixed

- `Build and test` is green on `main` again. The job had been red since 2026-10-16, so every merge ignored a check
  that hid real regressions:
  - A session boundary is never warm-up gated. `registerHook` kept every hook dormant until a session had more than
    `HOOK_WARMUP_TURNS` turns, and `session_start` fires while the count is still 0, so `SessionStart` disk hooks,
    `session_shutdown` and `session_before_compact` handlers were permanently dead rather than dormant
    (`.pi/lib/runtime/hook-state.ts`).
  - Background Bash no longer invents a blank line when a 50 ms poll splits a line from its newline: `echo hi` stored
    `hi\n\n` or `hi\n` depending on where the kernel split the pipe, which is why the suite failed under the full run
    and passed alone (`.pi/lib/tools/swarm-bgprocess.ts`, `takeLines`).
  - The knowledge store and supervisor settings refuse a symlink between the managed path and the *configured* root,
    not between it and `/`. On macOS `/var` and `/tmp` are symlinks, so every temporary workspace was rejected
    (`Unsafe knowledge directory`, `unsafe configuration path rejected`), and `memoryIdentity` now canonicalises the
    repository path so a worktree sees the notes its main checkout wrote (`.pi/lib/state/shared-memory.ts`).
  - The configure wizard compares a workspace file with the workspace's real path, so ordinary files are no longer
    rejected on macOS, and `paseo-service.mjs` compares canonical script paths so `render` runs from any directory.
  - Tests that predated an intentional change now assert the new contract: hook tests model a session past warm-up
    (`establishedHookContext`), `TaskBrowserView` takes the real `pi-tui` layout, the artifact-preview test waits for
    its own blob instead of the startup card's image, the Mermaid follow-up names its sources only for questions about
    that hook, memory search asserts the any-term BM25 ranking, and the Tern command tests read the accumulated surface
    instead of the last frame, which the asynchronous startup refresh could overwrite.
- Crash and portability fixes around the edges of a session: an MCP server that dies or closes its pipes now surfaces
  as a transport failure instead of an uncaught `EPIPE` (its last stderr line, control codes stripped and credentials
  redacted, becomes the error), a skill watcher that hits inotify's `ENOSPC` is dropped instead of aborting the
  process, the startup card no longer watches the whole worktree and git directory recursively, `/claw` launches
  workers in a login shell it probed (`PI_CLAW_SHELL`, `$SHELL`, then the usual zsh/bash paths) instead of a
  hardcoded `/bin/zsh`, and `.pi/mcp.json` resolves the GitHub MCP binary from `PATH`, `$GITHUB_MCP_SERVER` or
  `~/.local/bin` with the token taken from the active `gh` login (never stored).
- The same change is merged in `cloverinternational/plataforma` (#468) with both repositories' variables flipped: live dispatches now show `messages → claude-oauth` runs of 154 and 135 requests with **358** and **330** uncached tokens against 4.0M and 2.0M cache reads.
- OCR workflow: the resolved Plexus endpoint is exported into the preflight step itself, not only through `GITHUB_ENV` (which reaches later steps). Without it `ocr llm test` ran with no `OCR_LLM_URL`/`OCR_LLM_MODEL`, failed with "no valid LLM endpoint configured" and every review bailed at preflight.
- `node_modules` is no longer a tracked symlink. Commit 3746215 (PR #338) committed it as a link to the absolute path `/Users/swarm/Work/Clover/trebol/node_modules`; git stores a symlink as its target string, so every clone and every `git worktree add` materialized a link into one machine's directory — dangling elsewhere, and in its own checkout replacing the real dependency tree with a self-referential link (the Claw daemon died with `Cannot find package 'croner'`; after `npm ci` the missing directory read as `D node_modules`, which the launch gate refused as a modified source checkout). `git rm --cached node_modules` plus a `.gitignore` `node_modules` entry (no trailing slash — `node_modules/` matches directories only, which is how the symlink slipped through) removes and blocks it. Sharing dependencies between worktrees stays possible as an explicit, per-worktree, RELATIVE link via `node tools/repo/link-node-modules.mjs <source-checkout>`; nothing in the tooling or CI depended on the tracked link. `tools/repo/check-tracked-symlinks.mjs` (`npm run check:symlinks`, wired into CI as its own job that needs no install) reads the index and fails on any tracked symlink whose target is absolute or resolves outside the checkout, so the regression cannot recur.
- OpenCodeReview now speaks the Anthropic protocol to Plexus (`OCR_LLM_PROTOCOL=anthropic`, base URL normalised by `.github/scripts/ocr-llm-endpoint.cjs`), because its OpenAI protocol cannot emit `cache_control` and Plexus drops the field from `system[]` blocks anyway. Every `chat → claude-oauth` review request had re-billed its whole prompt — 3,400 requests and 98.7M uncached tokens in five days — and now caches: 23,188 uncached input tokens became 8,869 cache reads + 14,479 cache writes on the same review. See `docs/audits/plexus-chat-claude-cache-trace.md`.


## [0.7.1] - 2026-10-22

### Highlights

- Claw run lifecycle (#328, #329): a settled idle notice fires once per `launching`/`running` to `idle` transition instead of on every poll, `send` re-activates an idle or `awaiting_user` run whose next settled turn is then announced, a `launching` run fails after five minutes with a named reason, `claw list`/`status` report `ageSeconds`, remaining time and `since`, and the daemon closes its own tabs when a run completes, is cancelled or fails.
- Claw finish gate (#331): `claw_finish` reports the outcome once the worker's own TaskManage task is completed; unrelated tools and unfinished work stay blocked.
- Claw worker-local clarification (#333): a worker asks the user in its own tab through the native `ask_user_question` modal and continues the same run with the answer, reported as `awaiting_decision`.
- Claw launch resilience (#335): a preflight gate parses the registered entry points before a tab opens, transient load/parse/tool-conflict failures retry with bounded backoff while preserving the real error, deterministic configuration errors never retry, a source checkout that moved or gained tracked edits refuses the launch, and a worker that dies before `session_start` is `failed` with its captured reason instead of `lost`.
- Claw loads a repository's extensions once per worktree (#334): the launch plan identifies a repository by its git common dir and launches with an explicit extension plan, so a checkout registered twice no longer exits on a tool conflict.
- Claw `/reload` refreshes the detached daemon (#339): the daemon stamps a code fingerprint in `daemon.lock`, and a daemon whose code changed on disk is stopped (SIGTERM, bounded wait, SIGKILL only if ignored). Workers are never signalled.
- Runtime auto-continue after a task-gate stop (#337): a turn that ends because the gate blocked a tool receives one bounded instruction naming the remedy, at most twice per episode, and never after an abort, provider error, queued input, completed report or non-gate block.
- Task enforcement read-only exemption (#336): read-only domain lookups no longer fail with "YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK"; mutating siblings stay blocked.
- Tern ask dialog touch targets (#332): question tabs and option rows are tappable in single- and multi-choice, including the narrow (<60 column) layout.
- Tern runner startup (#307): `prepare` now builds `packages/tools/taskmanage/dist`, which `.pi/lib/tern/task-view.ts` imports, and `doctor` checks for it, so fresh checkouts no longer crash at startup.

### Added

- Claw: every worker run now carries an **always-on** completion goal. The condition is derived from the task the run
  was spawned for (its objective plus the acceptance criteria it states) and recorded on the run
  (`run.goal`, `claw_read`/`claw_list`/`/claw status`), in the task file the worker reads, and in
  `runs/<run>.goal.json`. The worker establishes it after launch in its own process — never as the positional launch
  prompt, which Pi would dispatch as a `/goal` command — and `claw_goal` lets a task widen it (widening only; nothing
  in the worker can remove it). There is **no turn cap, no deadline and no expiry**: while the judge answers NOT_MET the
  loop continues. Only semantic brakes end it, each exactly once: MET, IMPOSSIBLE, `claw_finish` (cleared *before* the
  report, so the settle that follows pays for zero judge calls), cancellation, the worker's own question, and any
  terminal run state. Status exposes condition, turns used, judge calls, last verdict and elapsed time; a goal that runs
  unusually long raises ONE warning notice and is never stopped by it. The judge's per-settle bound (8 tool turns, 8 MiB
  transcript) is unchanged. See `docs/claw/README.md`.
- Claw: worker-local clarification. A worker asks the user in its own tab through its native `ask_user_question` modal and continues the same run with the answer; the daemon reports the wait as `awaiting_decision` (distinct from the terminal `needs_user`/`awaiting_user`), refuses `claw_send` while a modal is open, never fabricates a question from a summary, and falls back to a truthful `needs_user` report when the modal is cancelled or unavailable. See `docs/claw/worker-clarification-2026-10-22.md`.
- Claw supervises itself: written SLOs the daemon enforces, so check-ups no longer need a human prompt. Every run is bounded to a terminal state (launch 300 s, idle stall report 600 s, supervisor fail 3600 s), every terminal run's worker tab is closed with jittered retries and one `run_tab_orphan` report when it cannot be, each act happens at most once per run per state inside a budget, low-severity notices collapse into one `claw_digest` per 5 minutes plus a heartbeat while workers run, a `needs_user` decision flags its own tab and repeats in bounded digests, and a run that provably produced nothing (a launch failure with no tab, or a worker that died before its first settled turn) is relaunched once on the same Hoja issue, while a run stuck past its own deadline is never restarted and records `run_budget_spent` with the reason. See `docs/claw/slo-2026-10-22.md` and `tools/claw/metrics.mjs`.

### Fixed

- Claw: a terminal run's worker tab is no longer left open when the Tern snapshot fails. `reconcileRun` gated the close on `live !== undefined`, so an unresponsive Tern skipped it with no retry, no report and no inbox kind; the close now runs regardless, retries with backoff, and reports an orphan once. `lost` runs are closed too.
- Claw: worker-local clarification. A worker asks the user in its own tab through its native `ask_user_question` modal and continues the same run with the answer; the daemon reports the wait as `awaiting_decision` (distinct from the terminal `needs_user`/`awaiting_user`), refuses `claw_send` while a modal is open, never fabricates a question from a summary, and falls back to a truthful `needs_user` report when the modal is cancelled or unavailable. See `docs/claw/worker-clarification-2026-10-22.md`.
- Prompt cache: the assembled system prompt no longer changes under a running session when the repository's tracked-file census changes. `<workspace_extensions files="N">` sits at byte ~467 of the system prompt (section 2, before the Forge, reporting, delegation and response-check sections), and `resolveWorkspace` re-ran `git ls-files` on every assembly, so one added or committed file rewrote the prompt at byte 543 and invalidated 97.2% of it. On fireworks/DeepSeek a single changed digit there drops the cached prefix from 5,692 tokens to 0 (measured on the live route; restoring the bytes restores the hit). The snapshot is now memoised per `<session>|<cwd>`, which matches Swarm (`sdk_integration_config.go LoadAndInjectContext` renders the workspace context once at startup), lets a new session still read a fresh census, and removes one `git ls-files` subprocess per assembly. Measurements in `docs/audits/prompt-cache-prefix-audit.md`.
- Claw worker launches survive an extension source that is being edited: a launch gate (`.pi/lib/claw/preflight.ts`) parses the registered entry points and their local imports before a tab opens, retries transient load/parse/tool-conflict failures with bounded backoff and jitter while preserving the real error, never retries deterministic configuration errors, and refuses a launch when the source checkout moved or gained tracked edits since the run was created. The gate's refusals and the startup-failure report both name the source checkout.
- Task enforcement: read-only domain lookups (`hoja_list`, `hoja_get`, `vault` `list`/`get`, `context_search`/`context_outline`/`context_read`/`context_inspect`, `HistorySearch`, `HistoryGet`) no longer fail with "YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK" when no task is focused. Mutating siblings (`vault` `add`/`remove`, `context_index`/`remember`/`reindex`/`delete`, spawning and sending tools) stay blocked.
- Claw: `/reload` now refreshes the detached daemon instead of leaving a supervisor running older code. The daemon stamps a code fingerprint (checkout HEAD plus a sha256 of `.pi/lib/claw` sources) in `daemon.lock`, exits when the code on disk changes, and `session_shutdown` with reason `reload` (plus `/claw on` and the next request) stops a daemon whose stamp differs — SIGTERM, bounded wait, SIGKILL only if ignored, and a reported failure instead of silence. Workers are never signalled and their runs reconcile from persisted state. See `docs/claw/daemon-reload-2026-10-22.md`.
- Runtime: a turn that ends because the task-enforcement gate blocked a tool no longer idles until a human types `continue`. When the run is about to settle after the gate's own block message with no further tool call, the runtime injects one bounded instruction that names the remedy (create or focus a TaskManage task, or use an already-exempt path such as read-only tools, or `claw_finish` once a task is completed). At most two auto-continues per episode, deduped per stop, reset by real progress or a real user turn; aborted runs, provider errors, queued input, completed reports and non-gate blocks are never resumed, and a spent budget surfaces a visible notice instead of looping.
- Claw: the idle notice is transition-only, `send` re-activates an `awaiting_user` run with a live tab and otherwise names the relaunch step, a `launching` run fails after five minutes with a reason, `claw list` reports `ageSeconds` and time left, and the daemon closes its own tabs for runs that complete, are cancelled or fail. Tern `close` answering "no block" counts as already closed.
- Claw: sending input to an idle worker re-arms the idle notice for its next settled turn, and `status` reports `since` for runs awaiting the user.
- Tern runner no longer crashes at startup on fresh checkouts: `prepare` now builds `packages/tools/taskmanage/dist` (imported by `.pi/lib/tern/task-view.ts`), and `doctor` checks for it.
- Tern ask dialog: question tabs and option rows are tappable. A tap on a single-choice row answers and advances like a digit key, multi-choice rows toggle, double-tap still activates, and the narrow (<60 column) layout keeps the same tappable rows.
- Claw: a worker can report its outcome with `claw_finish` after its own TaskManage task is completed; unrelated tools and unfinished work stay blocked by task enforcement.
- Claw workers start in a worktree of this repository again. Pi compares package sources by lexical path, so a checkout registered in `~/.pi/agent/settings.json` plus the same repository's own `.pi/settings.json` `packages: [".."]` loaded every extension twice and pi exited on `Tool "X" conflicts with ...`. New `.pi/lib/claw/launch-plan.ts` identifies a repository by its git common dir (realpath outside git), keeps the checkout the worker runs in, and launches the worker with an explicit `-ne -e ...` extension plan; distinct repositories are untouched and the decision is recorded in `launchNote`. A worker that dies before `session_start` is now `failed` with the reason from its captured stderr (`.swarm/claw/runs/<run>.worker.log`) instead of `lost`.

### Compatibility

- No extension entry point was added, removed or renamed in this release: `package.json` `pi.extensions` is unchanged from 0.7.0, and no tool was renamed.
- The task-enforcement gate is narrower, not removed. `claw_finish` (after the worker's own task is completed) and the read-only domain tools (`hoja_list`, `hoja_get`, `vault` `list`/`get`, `context_search`/`context_outline`/`context_read`/`context_inspect`, `HistorySearch`, `HistoryGet`) are exempt; mutating siblings (`vault` `add`/`remove`, `context_index`/`remember`/`reindex`/`delete`, agent-spawning and sending tools) remain blocked.
- `/reload` and `/claw on` can now stop a detached daemon that runs older code. In-flight workers are not signalled and their runs reconcile from persisted state.
- A turn stopped by the task gate may now resume on its own with a bounded remedy instruction, at most twice per episode. Aborted turns, provider errors, queued input, completed reports and non-gate blocks are never resumed, and a spent budget surfaces a notice instead of looping.
- `update-manifest.json` is at 0.7.1, so an installed 0.7.0 is told "Trebol 0.7.1 is available" and `/trebol-update install` performs the upgrade. `npm ci` runs `prepare`, which now also builds `packages/tools/taskmanage`.

## [0.7.0] - 2026-10-21

### Added

- Claw: orchestrator and worker runs routed through `/claw`, with worker tabs named after their task and per-launch `provider` and `model` options (default: unset, so Pi's configured provider and model are used; a provider requires a model).
- Hoja mode: read-only Hoja tools (`hoja_list`, `hoja_get`) registered through the `hoja-mode` extension.
- Ask-user: multi-select questions render as checkboxes.
- Upgrade prompt extension (`extensions/upgrade-prompt/`).

- OSC 7501 program-status reporting: Trebol now tells the terminal what it is doing (`idle`/`working`/`blocked`/`done`/`error`/`clear`) via terminal-native escape sequences, so terminals, multiplexers, and agentic inboxes can show session state without screen scraping. New `swarm-program-status` extension with a TTY gate and `TREBOL_PROGRAM_STATUS=0|1` override.

### Fixed

- Tern browser: `click` navigates and waits for the resulting load, `goto` waits for load, and a dead pane returns an actionable hint instead of a raw `no such pane` error.
- Tern groups consecutive tool steps into a turn summary (live view shows active steps; finished runs collapse to done/failed/interrupted) and restores persisted tool calls on reload.
- Ctrl+B moves the running foreground Bash command to the background.
- `/goal` verdict judging uses an answer-only prompt (MET / NOT_MET / IMPOSSIBLE).

- Preserve `--append-system-prompt` when the Forge prompt extension replaces Pi's default system prompt.

- TaskManage reuses saved answers with evidence revalidation, supports trusted evidence roots and explicit aliases, reports actionable citation errors, rebinds on session switches, and rolls back atomic cancellation. Add regression coverage and isolate hook-test environment state.

- `autogenskills` hook group starts disabled by default; enable it explicitly with `/hooks autogenskills on`.

- `apply_patch` and Bash `cwd` no longer reject paths outside the workspace. The workspace-only `checkAllowedPath` check is removed from both.
- Headless sub-agents no longer send `temperature`; `claude-haiku-5-5` rejects it with a 400. Model-default temperature is removed in headless mode too.
- Restore the bounded, centered overlay options for the `/btw` side-question view.
- Running-work detail view: PageUp/PageDown only scroll in detail mode.

## [0.6.0] - 2026-10-07

### Highlights

- Replace the previous ask-user implementation with the MIT-licensed
  `eko24ive/pi-ask` implementation in `extensions/ask-user`. Add structured
  questionnaires, single/multi-select answers, custom answers, notes, review,
  replay and settings. Run its 205 focused tests in CI.
- Port local compaction and context changes to the independent extension layout.
  Start estimated-context compaction at 325,000 tokens to leave headroom below
  the 330,000-token organization target; retain native compaction as a fallback
  for smaller models and unknown usage.
- Simplify footer reporting: remove the redundant context-model fallback label
  and duplicate autogenskills context gauge; show the active skill only when set.

### Compatibility

- The public tool name remains `ask_user_question`, but it now accepts the new
  questionnaire schema rather than the previous single-question schema.
- The former ask tool's autonomous-answer consultation and legacy timeout
  argument are not retained. Questions use the new explicit submit/cancel flow.
- Extensions are selected through `extensions/<name>/index.ts`. Existing custom
  resource filters using the old layer paths need migration; personal settings
  are not automatically rewritten.

### Other changes

- Flatten Pi extensions into individually selectable entries, preserve the tool surface, adopt native settlement/continuation, scope compatibility handlers, and repair macOS PTY execution and installation diagnostics.

- Add an open issue triage script under `tools/experiments` for batching repository issue review.
- Accept live tool results as TaskManage evidence, so in-session tool output can back completion answers.
- Rely on Pi's native CodeMode tool instead of the custom codemode registration.
- Improve the conversation footer: workspace/branch and model/state reporting plus schedule status countdowns.
- Add cited answers to scoped memory lookup: `memory_history ask`/`recall` return validated source cards alongside bounded answers.
- Correct blocked tool choices within the same session through the shared hook correction coordinator, with escalation after repeated attempts.
- Compact sessions at a fixed token threshold with mandatory compaction instead of waiting for pressure.
- Add a runtime switch (`/trebol-toggle`, Ctrl+N) for the Trebol extension pack with shape-checked reload and no per-press config writes.
- Reconcile TaskManage #38 review evidence and guard validation error decoration.
- Add `tools/repo/list-env-keys.py` to print environment variable names from a
  JSON array without exposing values, with optional prefix filtering.

- Accept canonical numeric task references in TaskManage: integer `taskId`,
  `parentTaskId`, `addBlocks`/`addBlockedBy` entries and `{ref}` targets are
  coerced to the decimal-string IDs returned by `op:list`/`op:create`, and
  `{"ref":"<task id>"}` now resolves a literal task ID when no key binding
  matches (cloverinternational/trebol#33, #35, #36).
- Match TaskManage evidence headings with punctuation (?, parentheses, commas)
  punctuation-insensitively on both sides, while exact and dash-slug matches
  keep working (cloverinternational/trebol#36).
- Repair bootstrap planner replies automatically: fenced JSON with trailing
  prose, unwrapped JSON followed by commentary, and payloads with trailing
  text no longer degrade bootstrap; truncated JSON still fails with a clear
  error.
- Split TaskManage evidence reference lists on `;` and `,` even when no
  whitespace follows the separator, so `a.md#X;b.md#Y` resolves both files
  like `a.md#X; b.md#Y` already did; separators inside headings that do not
  start a path-like reference remain unsplit.
- Resolve string task references in `addBlocks`/`addBlockedBy` against the
  persistent key ledger as well as the current batch, matching the
  `{"ref":…}` form so dependency arrays no longer fail with not-found when
  they name a task created in an earlier batch.
- Redesign the interactive Bash tool card to the Oh My Pi-style framed layout: framed call card, status header with success/error/timeout icons, labeled Output section with the same tail-window collapse, and a dim Wall/Timeout/Exit stats line.
- Add the reusable framed-card drawing helper for tool cards and let `renderShell: "self"` tools own their own collapse in the default renderer wrapper.
- Add a dedicated Read tool renderer (image-aware result summary and call card) and register it with the Read tool.
- Correct stale validation and parity documentation in AGENTS.md (removed `test:parity`/`parity:probe` references, fixed global-install import notes).
- Document global `pi install` usage in the README.

## [0.5.0] - 2026-09-28

- Require Mermaid diagrams in substantial explanations through all system-prompt paths, repair eligible Mermaid syntax errors, and add a one-shot follow-up hook.
- Improve history search resource handling and matching; refine tool gating and lifecycle behavior.
- Add renderer audit and capture tooling, documentation, and cleanup of accidentally tracked build/debug artifacts.
- Update task-management contracts and validation guidance.
- Check out submodules in the CI build-and-test job so the import-resolution check sees pinned vendor sources.

## [0.4.0] - 2026-09-23

- Add evidence-backed memory candidate capture, explicit offer handoff, bounded
  review, PageIndex source discovery, cited retrieval, and read-only memory-agent
  lookup. Keep unverified candidates distinct from verified knowledge; expose
  `/memory-capture`, `/memory-review`, and interactive `/memory-promote` controls.
- Capture TaskManage questions and evidence-backed answers; tighten task
  execution and bootstrap guidance, restore task state, and add the read-only
  `/tasks` browser.
- Add `/init` project interviews and inspect → plan → approved apply scaffolding,
  with workspace structure and Bash/path safeguards; improve tool argument
  contracts and diagnostics across history, MCP, vault, and CodeMode.
- Add `/supervisor` controls for optional Jev knowledge and operational audits,
  bounded memory maintenance, and reviewer status; include staged backfill and
  skill-curation tooling for manual review rather than automatic promotion.
- Add Clover startup notices and improve TUI tool renderers, hook lifecycle,
  agent settling, and prompt reassembly across workspaces and settings.
- Surface Paseo auto-start failures in startup notices without changing the
  explicit `/paseo setup apply` authorization introduced in v0.3.0. Retire the obsolete
  Swarm parity probes and fixtures; document retrieval and review limitations.
- Read the installed package version for update checks instead of a stale
  hard-coded value; keep release metadata, tests, and import checks consistent.

## [0.3.0] - 2026-09-17

- Add a provider-neutral long-running monitor agent with bounded retries,
  persisted observations, and pause/resume/cancel controls.

- Use Tailscale LocalAPI ETag/If-Match conditional writes to reject concurrent
  Serve changes, preserve JSON responses up to an explicit 8 MiB bound, and
  revalidate process start-time identity immediately before stopping a daemon.
- Require explicit `/paseo setup apply` or tool `apply: true` before modifying hostname
  configuration or Tailscale Serve; ordinary session startup does not expose the daemon.
- Retain daemon records on failed stops, clean up failed launches, support legacy
  stop records, and serialize update/build with lifecycle operations. Reject
  non-target Serve routes and anchor Linux atomic writes to directory descriptors.

- Automate per-machine Paseo Tailscale setup: preserve nested hostname config,
  hot-reload without restarting agents, configure nonconflicting persistent
  tailnet-only HTTPS routes, and verify HTTP plus WebSocket readiness.
- Use installation-relative Paseo paths, per-user daemon state, loopback defaults,
  bounded asynchronous subprocesses, and shared setup/start locking. Add focused
  regression tests and document installation prerequisites and limitations.

- Harden tool reliability, history argument normalization, and TaskManage validation.

- Add optional `/mem on|off|status` bootstrap memory enforcement with prompt and tool-call safeguards.

- Align HistorySearch field normalization and segment filtering with case, runtime, sorting, and ordering options.

- Add the paseo tool extension and register it in the 30-tools layer.
- Auto-start Paseo sessions with Tailscale-aware listening and add mobile relay pairing.
- Add a bootstrap-settings adapter that augments the native /settings panel.
- Mark the paseo vendor submodule as shallow.

- Add a repository-backed update checker with hourly checks (exposed as
  `/trebol-update` in v0.4.0).
- Allow overriding the update manifest URL with `PI_SWARM_UPDATE_URL` for testing.
- Add CI: mandatory changelog gate, release-metadata consistency, build and test.
- Add the Plexus OpenCodeReview (luna) advisory PR review workflow.
- Refine bootstrap selector evidence, shared-memory namespaces, and renderer output.
- Register the agent-mcp and oh-my-pi vendor submodules in `.gitmodules` so CI checkout succeeds.
- Sync `package-lock.json` with the `@pi-swarm/bootstrap` workspace so `npm ci` succeeds.
- Make tests CI-safe: honor explicit `headless: false` in InteractionBroker and derive the project name from the checkout path.

## [0.2.1] - 2026-09-15

- Accept the Kitty keyboard protocol CSI-u encoding of Enter in the running-work
  footer so inspection opens when Pi enables enhanced key reporting.
- Strip ANSI/OSC escapes and hard-wrap inspection text so a wide child transcript
  line cannot trip the editor's width validation and terminate the TUI.
- Treat a missing child transcript as an expected cleanup race: fall back to
  buffered output instead of surfacing a raw filesystem path, and catch rejected
  editor promises so a closing child view cannot raise an uncaught rejection.
- Add an optional per-user systemd unit installer for reboot-safe Paseo startup
  on Linux.
- Write goal-evaluation transcripts with 0600 permissions and a bounded size, and
  reject model-supplied regexes that can backtrack catastrophically.
- Treat combining marks and ZWJ sequences as zero-width in the metrics footer so
  accented text and emoji are no longer truncated early.

## [0.2.0] - 2026-09-11

- Harden bootstrap task handoff so generated guidance is attached through valid TaskManage operations.
- Make Forge prompt transparency explicit for debugging and testing.
- Clarify vault tool and command descriptions for stored connection entries.

## [0.1.0] - 2026-01-01

- Initial Pi-Swarm extension pack release.

To publish a release, update the root package version, this changelog, and
`update-manifest.json` in one commit, then tag the commit. The checker only
notifies; `/trebol-update install` delegates installation to Pi with
`pi update --extensions`.
