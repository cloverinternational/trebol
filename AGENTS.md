# Pi-Swarm Agent Contract

This file is the repository's operating contract for every coding agent. Read
it before changing anything. If a change makes this file inaccurate, update
`AGENTS.md` in the same change. A task is not complete until the index,
architecture notes, and commands below still describe the repository.

## Repository-local design skills

For Tern UI/UX work, read
[`skills/tern-native-experience/SKILL.md`](skills/tern-native-experience/SKILL.md)
before designing or implementing. It covers ambitious native GUI interfaces,
proactive interaction improvements, composer/input ergonomics and collapsed work.
Read its [work and composer checklist](skills/tern-native-experience/references/work-and-composer.md)
when changing those surfaces. These skills live in the root `skills/` directory,
not a provider-specific hidden directory; this explicit pointer makes them
available to agents regardless of their automatic skill-discovery conventions.

Fetch **https://docs.stencil.so/tern/index.md** at the start of each Tern UI task
and follow the current links for the latest design and protocol documentation.
Verify support against the installed Tern version rather than assuming the latest
published API is already available locally.

### Progressive work inspection

Background commands and agents use `background-panel.ts` for a unified native
manager and `background-format.ts` for bounded presentation: safe ANSI, complete
JSON formatting, diagnostic badges and stable-ID visible agent messages/tool
results. The dock carries no work card: the composer bar holds one pulse
(`composer-view.ts` `workChip`) — a Tern-clocked `spinner`, the live count, and the
newest job's name revealed on hover/focus — which opens the work sheet on click
and disappears the moment nothing is live. The status band clips its own children,
so never put a floating panel in the bar; the list belongs in that sheet. Finished
work stays readable there for 15 minutes while the runtime still tracks it, reached
by clicking the pulse or typing `/work`, never as a standing composer row.
Follow live/Pause viewing affects only the display. Stop requests are single-flight
and do not claim cancellation before runtime settlement. Agent reasoning is not
projected. Raw text is sanitized, not a byte-for-byte terminal escape replay.
Tests: background-panel, dock, composer-view, background-button under `.pi/test/tern/`.
Native fixture harness: `node tools/e2e/tern-background-manager.mjs`.
Rendered-box measurement (real `tern serve`, not our own CSS):
`node tools/e2e/tern-composer-work-chip.mjs`.

Tern work groups show their steps as one tree with exactly **one** affordance, a
quiet `Inspect steps` line (`tern.work-inspect`) that opens the step overlay.
The card itself carries no filter, fold or mode buttons: the native head chevron
and head click fold it, Ctrl+O opens every step, and `/work` opens the work
sheet. `work-inspector.ts` provides the overlay's All / Active / Failed filters,
search and selected-step detail; `bridge.ts` keeps only the group fold through
streaming and settlement. Headers retain failure and cancellation badges (never
a "completed" count that repeats `Done`), and a collapsed live group can show
the current action when no narration tail exists. The inspector searches safe
step summaries, shows bounded captured output with explicit truncation, and
reveals the original step without globally expanding other groups. It neither
retries nor cancels operations. Raw/native input is isolated from the composer,
and session replacement drops the inspector.
Tests: `.pi/test/tern/work-inspector.test.ts` plus work-table, turn-work and
turn-groups. Runner changes require restarting the pane.

## Index

1. [Mission and architecture](#mission-and-architecture)
2. [Repository map](#repository-map)
3. [How Pi is composed](#how-pi-is-composed)
4. [Extension inventory](#extension-inventory)
5. [Package boundaries](#package-boundaries)
6. [Change contract](#change-contract)
7. [Validation](#validation)
8. [Safety and vendor policy](#safety-and-vendor-policy)
9. [Capability locator](#capability-locator)
10. [AGENTS.md discovery](#agentsmd-discovery)

## Mission and architecture

Pi-Swarm is a Pi extension-based Swarm runtime. Pi owns the provider/agent
loop, session manager, native tools, and terminal UI. This repository adds
Swarm prompt assembly, policy, hooks, persistence, task/subagent workflows,
history, skills, MCP/vault adapters, parity behavior, and UI extensions.

The governing separation is:

```text
Pi AgentSession + SessionManager
        │ lifecycle, context, provider, native tools
        ▼
Pi ExtensionAPI (extensions/<extension>/index.ts)
        │ registration, gates, persistence, rendering
        ├── 00-runtime   ── integration boundary, hook engine, tool surface, parity
        ├── 10-context   ── swarm-prompt + swarm-context, plan mode, skills
        ├── 20-policy    ── policy + disk hooks + structure guard + policy nudges
        ├── 30-tools     ── agents, tasks, history, fs, bash, MCP, vault, research
        ├── 40-state     ── session entries + .swarm stores
        └── 50-ui        ── renderers, widgets, status, footer, themes
```

Semantic state, authorization, persistence, and cancellation must not depend
on whether a TUI frame rendered. Do not infer runtime state from assistant
prose or rendered text when a lifecycle event or persisted entry is available.

## Repository map

Everything is filed by one rule — *what does it primarily register or
export?* — into six layers. The same six names are used for Pi extensions,
shared libraries, their tests, and the npm packages, so a concept has one
address in each tree.

| # | Layer | Owns |
| --- | --- | --- |
| 00 | `runtime` | integration boundary, hook engine, tool surface/gating, transport parity, telemetry |
| 10 | `context` | system prompt, prompt/context config, plan mode, thinking, skills, inspector |
| 20 | `policy` | disk hooks, project structure guard and `/init`, sleep blocker, nudges |
| 30 | `tools` | every Pi-Swarm `registerTool` surface: bash, fs, search, agents, tasks, schedule, history, vault, research, MCP, ask-user, annoyed; CodeMode is provided by Pi |
| 40 | `state` | durable session entries: memory history, conversation metadata |
| 50 | `ui` | control panel, metrics widgets, themes, tools-status command, Pi-Swarm-owned `/btw` side-question card (input-slot takeover, not an overlay) |

The root `extensions/trebol-toggle/index.ts` is always loaded and remains resident
when the project extension pack is disabled. Each layer manifest points to its
own `.trebol-guards/` wrapper, which dynamically imports exactly one original
factory when the process-local `Symbol.for("pi-swarm-trebol-mode")` state is
`on`. These nested directories are intentionally not autodiscovered. Ctrl+N
directly invokes reload through the shape-checked `trebol-shortcut.ts` runner
adapter; it never sends a user message. `/trebol-toggle` shares the same handler.
Reload is allowed only while idle with no queued messages. No per-press config
write occurs. Keep the root and local discovery paths deduplicated by resolved
path, and preserve native tools and unrelated extensions while disabled.

| Path | Purpose |
| --- | --- |
| `extensions/<name>/` | One extension per folder. Root package.json lists enabled index.ts entrypoints explicitly. extension.ts holds implementation; index.ts preserves whole-suite toggle behavior. No numbered layers or umbrella runtime. |
| `.pi/lib/<layer>/` | Shared extension/runtime helpers, filed by the same rule. Hook infrastructure (`hook-state`, `hook-observations`, `hook-presenter`, `hook-render-bridge`) lives in `.pi/lib/runtime/`. |
| `.pi/test/<layer>/` | Tests for `.pi` code. A test lives in the layer of the module it primarily imports. |
| `.pi/config/` | Project configuration: `prompt-context.json`, `swarm-settings.json`, and the ignored `api-keys.json`. |
| `.pi/themes/` | Local Pi theme definitions. |
| `packages/<layer>/<name>/` | npm workspaces (`packages/*/*`). Directory name equals the npm name suffix: `packages/runtime/core` is `@pi-swarm/core`. |
| `packages/runtime/` | `core` (the shared tool renderer), `runtime-contracts` (control-plane, daemon, goal-loop, task interfaces). |
| `packages/context/` | `prompt` (canonical prompt markdown and provenance), `skills` (loader, registry, builtins), `autogenskills` (generated-skill lifecycle). |
| `packages/experimental/` | `absurd-worker`: the Absurd daemon, control plane and general-agent adapter, deliberately outside the local agents graph. `npm run build:experimental`. |
| `packages/tools/` | `agents`, `taskmanage`, `mcp`, `schedule`. |
| `tools/experiments/patch-parity/` | Runs the pinned upstream apply-patch scenario corpus (`fixtures/scenarios`, openai/codex `430a16799d90e296fb27b1e94f206023902b7e56`) against Trebol: `node --experimental-strip-types tools/experiments/patch-parity/runner.ts standalone\|agent`. `oracle` mode needs `CODEX_APPLY_PATCH_BIN` pointing at a built upstream binary and otherwise reports BLOCKED. Fixture expectations are upstream-authored and were not produced by executing the oracle. |
| `tools/experiments/bootstrap-agent/` | Opt-in bootstrap experiments; `planning-contract.mjs` provides experimental prompt variants and strict plan validation. Private history replays stay in ignored artifacts; planning scores do not prove execution or memory retrieval. |
| `tools/integration/` | Postgres integration runner and cache dogfood. |
| `tools/install/` | `doctor.mjs`: global-install health check (`npm run doctor`). |
| `tools/docs/` | Diagram generators, never hand-drawn assets. `runtime-state-diagram.mjs <out.svg>` emits `docs/architecture/runtime-state-relocation.svg` and exits non-zero on text overflow, on a rect that paint order puts over earlier text, or on contrast below WCAG AA. `tests/runtime-state-diagram.test.ts` regenerates and byte-compares the committed file, matches its env names and paths against `stateRoot`/`workspaceKey`/`clawStateDir`, and rejects any `.swarm` destination outside the known legacy/input set. Regenerate instead of editing the SVG. |
| `tools/repo/` | Repository maintenance: `rewrite-imports.mjs` re-targets relative specifiers after moves and has a `--check` mode; `check-tracked-symlinks.mjs` fails on a tracked symlink that escapes the checkout (`npm run check:symlinks`); `link-node-modules.mjs` is the opt-in, per-worktree, relative dependency sharing helper. |
| `docs/architecture/` | Living design descriptions. |
| `docs/reference/` | Contracts, inventories, and operational references. |
| `docs/parity/` | Parity plan, acceptance record, and VHS media. |
| `docs/plans/{active,archive}/` | Plans still driving work; executed plans headed with what superseded them. |
| `infra/` | `postgres/` compose stack, `bridges-go/` Go bridge. |
| `vendor/` | Read-only references: `pi-mono`, `swarm-sdk`, and the `opencode` and `page-index` submodules. Never edited and never imported at runtime. |
| `artifacts/` | Ignored. Recordings and experiment outputs (e.g. `artifacts/tool-cards/`). |
| `.swarm/`, `.pi/agent-sessions/` | Ignored runtime state; never a source of truth for implementation. |

Naming rules: directories and Markdown files are `kebab-case`; the only
capitalised files are `AGENTS.md`, per-package `README.md`, and skill
`SKILL.md`/reference files whose names are contractual. `dist/`,
`node_modules/`, `artifacts/`, `.pi/agent-sessions/`, and `.swarm/` are never
tracked. Generated files say so in their header and name their generator.

Never track a symlink that points outside its own checkout. Git stores a
symlink as its target string, so `node_modules -> /abs/path` (tracked by
3746215, removed here) dangles in every other clone and, in the checkout that
owns the path, materialises over the real directory and leaves a
self-referential link — the Claw daemon then dies with `Cannot find package
'croner'` and the missing directory reads as `D node_modules`, which the launch
gate reports as a modified source checkout. `.gitignore` cannot fix what is
already tracked, so `npm run check:symlinks` reads the index in CI and fails on
any absolute or escaping target.

## How Pi is composed

1. Pi loads the root package manifest, which explicitly lists `extensions/<name>/index.ts`. The project `.pi/settings.json` points to the root package.
2. Extensions register tools with `pi.registerTool`, commands with
   `pi.registerCommand`, shortcuts with `pi.registerShortcut`, and lifecycle
   handlers with `pi.on`.
3. `session_start` establishes session-scoped state and rehydrates persisted
   entries. `before_agent_start` composes the effective prompt/context.
4. The agent loop requests the provider, handles assistant output and tool
   calls, then emits tool and turn lifecycle events.
5. Policy/hook extensions observe or gate calls at `tool_call`; execution
   outcomes are handled at `tool_result`/`tool_execution_end`.
6. Extensions persist bounded, non-secret state with `appendEntry`; they must
   discard stale session/context references after replacement or shutdown.
7. Pi renders tool calls/results through native renderers. Swarm presentation
   uses `renderCall`/`renderResult`, entry renderers, widgets, status, and
   footer APIs rather than writing transcript content for UI-only state.

Important UI locations:

- **Bottom/footer:** `extensions/conversation-metrics/extension.ts`; it calls
  `ctx.ui.setFooter(...)`, shows workspace/branch and model/state above context
  pressure, reported output tokens and accumulated active time. It uses semantic
  success/accent colors on the terminal's default background; narrow panes drop the
  provider/gauge and wrap groups. Unknown context shows a dash. Conditional
  extension segments occupy detail rows; expanded running-work remains available.
  Idle status shows the earliest live session loop/schedule countdown through the
  read-only `.pi/lib/runtime/schedule-status.ts` bridge; WORKING takes precedence.
  It refreshes with `requestRender()`. Pi has exactly one footer slot, so this
  extension is its sole owner: other extensions must not call `setFooter`.
  They contribute a text segment through the process-wide registry
  `globalThis[Symbol.for("pi-swarm-footer-segments")]` (a `Map<name, () =>
  string | undefined>`; `autogenskills` registers `"autogen"` there). Extension
  factories must guard re-entry per `pi` instance (WeakSet/WeakMap), never with
  a process-wide boolean: `/reload` re-evaluates modules with a fresh `pi`
  while `globalThis` survives, and a boolean guard silently skips registration.
- **Inline hook rows:** `.pi/lib/runtime/hook-render-bridge.ts` and `.pi/lib/runtime/hook-presenter.ts`.
- **Windows image paste:** `extensions/swarm-image-paste/extension.ts` with
  `.pi/lib/ui/windows-clipboard.ts`. It registers `ctrl+v` and `/paste-image`
  on win32 only, because Pi binds `app.clipboard.pasteImage` to `alt+v` there
  and its clipboard reader falls back to PowerShell only under WSL. Extension
  shortcuts are dispatched before built-in keybindings and `ctrl+v` is not a
  reserved binding, so Pi's `alt+v` keeps working. Do not register on other
  platforms: Pi's own `ctrl+v` is correct there.
- **Themes:** `.pi/themes/*.json`.

The detailed design references are
`docs/architecture/modular-pi-architecture.md`,
`docs/architecture/swarm-tui-to-pi-map.md`, and
`docs/architecture/hooks-prompts-tools-pi-equivalence.md`. Update those
documents when a change alters a documented architectural boundary.

Tool-output spillover is documented in `docs/reference/tool-output-spillover.md`.
Shared persistence and estimated-token budgets live in
`.pi/lib/runtime/swarm-toolout.ts`; `swarm-toolout-boundary.ts` applies them to
tool-result text independently of task-hook gates. Bash also spills before its
formatter can discard output. Recovery files are private OS temporary files,
not durable project artifacts; the estimate is UTF-8 bytes divided by four,
rounded up, not a provider tokenizer count.

## AGENTS.md discovery

Pi-Swarm now discovers instructions hierarchically through
`.pi/lib/context/swarm-context.ts` and injects them through `extensions/swarm-prompt/extension.ts`.
The algorithm follows the current working directory's lexical path upward to
the nearest `.git` directory or `.git` file, then loads one instruction file
per directory from repository root to the working directory. If no Git root is
found, only the working directory is considered.

Within each directory, the precedence is:

1. `.swarm/AGENTS.md`
2. `.claude/AGENTS.md`
3. `AGENTS.md`

The selected files are concatenated root-first, so deeper instructions can
supplement or refine broader rules. Missing files are ignored. This is the
hierarchical ancestor model used by Swarm/OpenCode-style agents; it is **not**
a recursive scan of every sibling or descendant directory. A package-local
file becomes active when the agent's working directory is inside that package.

The discovery API is `discoverAgentsMdPaths(workDir)`. The context pipeline
uses it for `agentsMd`, records every discovered path in prompt provenance,
and applies the existing source/total byte budgets. `--no-context-files` /
`--no-project-memory` disables this source along with the other project memory
files. Do not replace this with a fixed root-only lookup or a recursive whole
repository scan without updating tests, budgets, and this contract.

When changing discovery, preserve these invariants:

- walk the logical path supplied as the workspace; do not silently canonicalize
  through symlinks before choosing ancestors;
- stop at the nearest Git root and never load parent-workspace instructions;
- preserve root-to-leaf ordering and one winning candidate per directory;
- keep instruction contents bounded and exclude secrets from provenance/logs;
- test Git directories, `.git` files, nested packages, no-Git fallback, and
  same-directory precedence.

## Extension inventory

| Layer (load order) | Entrypoints |
| --- | --- |
| `00-runtime` | `cache-telemetry`, `swarm-update`, `hooks`, `swarm-runtime`, `swarm-transport-parity` |
| `10-context` | `autogenskills`, `prompt-context-configure`, `swarm-plan-mode`, `swarm-prompt`, `swarm-auto`, `swarm-skills`, `swarm-thinking`, `system-inspector`, `system-prompts` |
| `20-policy` | `swarm-disk-hooks`, `project-init` |
| `30-tools` | `annoyed/`, `control-task-tools`, `history-search`, `ask-user/`, `hoja-mode`, `claw`, `paseo`, `project-context`, `research-tools`, `swarm-goal`, `swarm-agent-tools`, `swarm-background-bash`, `swarm-bash`, `swarm-fs-tools`, `swarm-history-vault-tools`, `taskmanage`, `vault` |
| `40-state` | `memory-history`, `task-candidate-capture`, `knowledge-enrichment`, `candidate-memory-review`, `jev-knowledge-audit`, `memory-maintenance`, `swarm-conversation-metadata` |
| `50-ui` | `control-panel`, `supervisor`, `conversation-metrics`, `swarm-themes`, `swarm-tools-status`, `swarm-btw`, `swarm-image-paste`, `swarm-program-status` (through `.trebol-guards/` wrappers) |
| feature (tail) | `voice` |

The list in each layer's `package.json` is authoritative; this table mirrors
it. Adding an extension means adding the file *and* its manifest entry.

### Voice (dictation) builtin

`extensions/voice/` is the MIT-licensed Pi Voice extension carried as first-party
source: no `.git`, no `repository`/`homepage`/`bugs`/`publishConfig` fields, no
upstream CI or `package-lock.json`, and its legacy Git-install notice module is
removed. `LICENSE` is preserved verbatim; provenance lives here, not in code.
Its entry is appended last in the root manifest, so it loads outside the `50-ui`
Trebol guards.

It registers the `transcribe_file` tool, `/voice` (toggle capture),
`/voice-settings` (+ `/transcribe` alias), an optional `/voice-onboarding` under
`PI_VOICE_DEBUG=1`, and one configurable shortcut (`Ctrl+Space` by default from
`src/default-shortcut.ts`). Settings are `<agent dir>/pi-voice.json`, the log
`<agent dir>/pi-voice.log`; model weights and the VAD gguf are downloaded into
the agent directory on first setup, so audio never leaves the machine.

Runtime dependencies (`@handy-computer/recorder`, `transcribe-cpp`,
`@huggingface/hub`, `opencc-js`) are declared both in
`extensions/voice/package.json` and in the root manifest, which is what actually
installs them. `transcribe-cpp` is imported as `import type` only and the real
native loads are dynamic (`src/vad.ts`, `src/audio.ts`), so a missing native dep
degrades at first recording rather than at extension load. FFmpeg is required
only for `transcribe_file` (`PI_VOICE_FFMPEG_PATH` overrides the lookup).

Validation: `cd extensions/voice && npm run check && npm test`
(`tsc --noEmit`, then 131 `node --test` cases through `scripts/run-tests.mjs`,
which resolves `typescript` via Node resolution because the monorepo hoists it),
and `npm run check:install -- --extension extensions/voice/index.ts` at the root.
`tools/install/extension-inventory.mjs` currently aborts before scanning because
`pi-host.mjs` resolves the **global** Pi (1.1.0) whose nested `pi-codemode` lacks
`MCP_TYPESCRIPT_PREAMBLE`; that skew predates this extension and is unrelated to
its entry.

In a Tern pane the recording meter and status lines work because
`.pi/lib/tern/ext-ui.ts` accepts the plain-text widgets this extension paints;
its `ctx.ui.custom` panels (settings, onboarding, model and microphone pickers,
shortcut recorder, try-it) are refused with a "needs Pi's terminal UI" notice.


An extension is an adapter, not a second agent runtime. Prefer Pi native
capabilities and shared policy over duplicate tools or parallel global state.

## Capability locator

Hoja filing recovery: `extensions/hoja-mode/projects.ts` registers `hoja_project`
(list/select/create), exposed by `swarm-tool-gating.ts`. Missing projects trigger bounded
automatic discovery and report candidates for a user filing decision; nothing is blocked. Creation
requires native confirmation and journaled intent.
The destination is saved per chat, and selection invalidates the Hoja client catalog.
See `docs/reference/hoja-task-publication.md` for live reproduction and verification limits.

Use this section when a user names a tool, skill, or hook. Start at the public
Pi extension, then follow its imported package/library. Keep the extension
thin: execution/domain logic belongs in the package or `.pi/lib/`, authorization and path
boundaries belong in `.pi/lib/tools/` (`path-guard.ts`), and rendering belongs in the
extension/render bridge.

### Tools by user-facing name

| Tool(s) | Pi registration | Owning implementation / seam |
| --- | --- | --- |
| `bash` | `extensions/swarm-bash/extension.ts` | `.pi/lib/tools/swarm-bash.ts`; policy must gate execution separately. |
| `Read`, `apply_patch` | `extensions/swarm-fs-tools/extension.ts` | `.pi/lib/tools/swarm-apply-patch.ts`, `.pi/lib/tools/swarm-read-image.ts`; filesystem boundary is an explicit decoupling seam. `apply_patch` follows pinned upstream Codex V4A semantics (parse, then validate with no writes, then sequential execution with no rollback; first-match context; per-line endings). There are no file snapshots or `Undo` tool (removed 2026-10-27: 1 call in 354 sessions, unbounded `.swarm/snapshots` growth); revert with git. Known exclusions and the oracle status are in `docs/parity/codex-apply-patch-audit.md`. Do not reintroduce atomicity or ambiguity-rejection claims. |
| `Agent`, `AgentControl` | `extensions/swarm-agent-tools/extension.ts` | `packages/tools/agents/src/index.ts`; child runner/session isolation lives in `packages/tools/agents`. |
| `task_create`, `task_update`, `task_get`, `task_list`, `task_delete`, `task_claim`, `task_note`, `task_plan`, `task_complete`, `task_reopen`, `task_block`, `task_unblock`, `task_focus`, `task_unfocus`, `task_status`, `run_status` | `extensions/taskmanage/extension.ts`, `extensions/control-task-tools/extension.ts` | `packages/tools/taskmanage/src/task-manage.ts`, `packages/tools/taskmanage/src/workflow.ts`, `packages/tools/taskmanage/src/persistence.ts`, `packages/runtime/runtime-contracts/src/control-task.ts`; do not duplicate task state in extensions. |
| `HistorySearch`, `HistoryGet` | `extensions/swarm-history-vault-tools/extension.ts` and `extensions/history-search/extension.ts` | `.pi/lib/tools/swarm-history-tools.ts` with shared `history-reader.ts`, `history-matching.ts`, and `history-admission.ts`; streaming history is read-only, resource-budgeted, redacted, and reports incomplete scans. See `docs/reference/history-search.md`. |
| `memory_history` | `extensions/memory-history/extension.ts` | `.pi/lib/state/shared-memory.ts`: repository-default immutable records under `~/.swarm/memory` (override `PI_SWARM_MEMORY_DIR`), Git-common-dir repository identity, worktree overlay and explicit global scope. Legacy session scope remains readable. Redact before writes. |
| `project_context` | `extensions/project-context/extension.ts` | Read-only hybrid (dense + BM25, RRF k=60) search over repo markdown and `.ts`/`.mjs` source including `.pi/`: legacy-SSE MCP client for Agent-MCP `ask_project_rag` on spark (`PROJECT_CONTEXT_URL`, default `http://100.84.178.124:8090`; token from `PROJECT_CONTEXT_TOKEN` or `~/.config/agent-mcp/spark-token`). Spark runs systemd user units `embeddinggemma` (`google/embeddinggemma-2`, 768d, `127.0.0.1:8200`) and `agent-mcp` (patched branch `embeddinggemma`, `AGENT_MCP_CHAT_MODEL=none` returns ranked chunks; `AGENT_MCP_ADVANCED=1` enables code indexing, `AGENT_MCP_INDEX_DOTDIRS=.pi`, `AGENT_MCP_DOC_TITLE=path`, `AGENT_MCP_HYBRID=1`; the embedding server serialises encodes because 25 concurrent requests OOM-killed it). Keyword-only hits show `keyword match`; Agent-MCP per-file code summaries cite the bare path. Chunks map to local `path#Lx-Ly`; a mismatch is flagged stale. The spark corpus is a copy (`~/trebol-corpus-v2`) and must be re-synced after doc changes. E2E: `node tools/e2e/project-context.mjs`. Not task-gate exempt. Sealed evaluation (`artifacts/memory-audit/h2h-results.md#project_context-eval`, local artifact; reproduce with `node tools/e2e/project-context-eval.mjs`): hybrid beats dense-only, nDCG@10 +0.144 [95% CI +0.077, +0.214]; beats rg by +0.396. The downstream agent benefit over ripgrep is not established: A−B pass rate −0.067 [−0.333, +0.200], and the agent never chose the tool unprompted. Regex-gold hit rates are not a valid retrieval metric. |
| `memory_history recall` | `extensions/memory-history/extension.ts` | `.pi/lib/context/knowledge-pageindex.ts` projects scoped records into read-only PageIndex sections; `.pi/lib/context/memory-agent.ts` calls an isolated Pi model whose only tools are `memory_browse`, `memory_read`, and `memory_select` from `.pi/lib/state/memory-retrieval-worker.ts`. The parent validates selected IDs against its snapshot. Candidate results are leads, never verified recall; writes still use explicit store operations. |
| `memory_history offer` | `extensions/memory-history/extension.ts` | `.pi/lib/context/memory-handoff.ts` accepts bounded explicit text, source and evidence; tool-less Pi consultation judges durable project knowledge, then the parent writes only a candidate through `KnowledgeStore`. A content/source-derived ID deduplicates retries. A read-only PageIndex projection acknowledges the exact saved revision as `stored-indexed`, otherwise `stored-index-pending` with a retry hint. No global or verified write. |
| `project_init`, `/init` | `extensions/project-init/extension.ts` | `.pi/lib/policy/project-scaffold.ts`, `.pi/lib/policy/project-structure.ts`. `/init` injects an interview brief via `sendUserMessage`; the agent interviews with `ask_user_question` and calls `project_init` (`inspect`/`plan`/`apply`). There is no modal wizard. `apply` never clobbers existing files. Like `memory_history`, this is an intentional model-facing extension tool, so `swarmSurfaceFor` must keep `project_init` on the surface — otherwise it registers but is gated out and the agent reports it as missing. |
| `hoja_list`, `hoja_get`, `hoja_project`; `/hoja on\|off\|status`; automatic TaskManage → Hoja publication | `extensions/hoja-mode/extension.ts` (on by default) | `extensions/hoja-mode/publish.ts` decides from the TaskManage result what is coarse enough to publish (top-level task, or `metadata.hoja:"publish"`; `metadata.hoja:"local"` stays local), reuses a named issue (`metadata.hojaIssue`) without writing to it, resolves the project from declarations — `metadata.hojaProject`, then the chat's target (a `hoja_project` selection, or the host option), then the repository's `.pi/config/hoja.json`, then `HOJA_PROJECT` — never from the workspace directory name, and an agent-named project that does not exist falls back to the repository project with `substitutedFrom` recorded instead of failing the registration; `hoja_project` `action=list` reads the real catalogue including empty projects (`hoja_list` only lists issues), `action=select` remembers an exact project per chat, and `action=create` creates one in an exact team after a host confirmation that shows name and team, journaling the attempt before the request and reconciling it by exact name and team. It writes through the shared client in `.pi/lib/claw/hoja.ts` (`createIssue` with `parentId`, `findIssueByIdentifier`, read-back with `Issue.parent`). The client resolves credentials per value — canonical `HOJA_TOKEN`/`HOJA_API_URL` first, the deprecated `LINEAR_TOKEN`/`LINEAR_API_URL` aliases only as fallbacks, a blank value treated as unset, and an unset token reported as `HOJA_TOKEN … (deprecated fallback LINEAR_TOKEN …)` — so a session that exports only the canonical pair still authenticates. Associations are journaled as `hoja-task-link` entries and replayed per chat. The pre-write intent is journaled *before* the create request, and any unconfirmed write stays `reconciling` with a description marker; `findIssueByMarker` plus a read-back that proves marker, project and parent is the only way one is adopted, so a marker miss is never retried as a create. A promoted child is deferred (`parent_unpublished`) unless its parent already has an issue. Batches are serialized per session and a generation guard stops an in-flight batch after `/hoja off`, a chat switch or shutdown; the outcome is appended to the TaskManage result, so the model — not only the UI — learns about a skip such as `no_project` and can retry it with corrected metadata. Missing filing is recovery, not a gate: on `no_project`/`project_unresolved` the extension runs bounded catalogue discovery (journaled as `hoja-recovery`, replayed on resume), reports up to 12 candidates with descriptions and team keys and never picks one, retries the same task once when a declared mapping becomes resolvable, and blocks no tool; queued tasks (authoritative snapshots with canonical answers, bounded, journaled, replayed on resume; deleted and `hoja:local` work dropped; overflow reported) are retried automatically after a selection or on a later plain TaskManage update, with the retry chained into the same serialized queue, and an unfiled completion is reported honestly. An ordinary `hoja_project` select is session-only; only select with `remember:true` (host-confirmed) or create persists the mapping to `.pi/config/hoja.json`, at the repository root resolved from `.git`, preserving existing keys and refusing malformed or symlinked files. A session-owned issue is kept current and closed by `lifecycle.ts`; a reused or shared issue is never written to. `/hoja off` disables publication and guidance; the read tools stay read-only. Docs: `docs/reference/hoja-task-publication.md`; tests: `.pi/test/tools/hoja-publish.test.ts`, `.pi/test/tools/hoja-lifecycle.test.ts`, `.pi/test/tools/hoja-recovery.test.ts`, `.pi/test/tools/hoja-recovery-cache.test.ts`, `.pi/test/tools/hoja-config.test.ts`. |
| `skills_list`, `skill_view` | `extensions/swarm-skills/extension.ts` | `packages/context/skills/src/index.ts` and `.pi/lib/context/swarm-skill-registry.ts`; skill bodies/support files stay on disk. |
| Final Mermaid response repair and follow-up | `extensions/mermaid-response/extension.ts` | `.pi/lib/context/mermaid-response.ts` and `mermaid-followup.ts`; `message_end` replaces only successful finalized assistant text before persistence/final redraw. The streaming preview may already have shown the original. Mermaid fences are processed independently (up to 16); only one narrowly recognized flowchart arrow or sequence-message colon per diagram is changed after successful revalidation. Other syntax and validator failures preserve the original. For conceptual/explicit-diagram user requests, `turn_end` queues one model-visible `followUp` if a substantial final explanation lacks a Mermaid fence; it does not replace the previous response, and a second omission does not loop. The follow-up text tells the model to stay on the original request and names the hook's own source files only when the prompt is about the Mermaid hook; it is never sent in subagents (`PI_SWARM_SUBAGENT=1`), whose final text is the deliverable (#299; e2e `node tools/e2e/mermaid-followup-stays-on-task.mjs`). Pi's terminal Markdown renderer displays Mermaid as code, not SVG connectors; connector color belongs in the actual diagram-rendering client. |
| `Skill`, `SkillManage` | skill/autogen integration via `extensions/swarm-skills/extension.ts`, `extensions/autogenskills/extension.ts` | `packages/context/autogenskills/src/index.ts`; mutate skills only through the vault/revision API. |
| `web_fetch`, `deepwiki`, `browser_get_page` | `extensions/research-tools/extension.ts` | Extension-local bounded evidence fetcher; provenance and network policy are coupled requirements. |
| `transcribe_file`, `/voice`, `/voice-settings` | `extensions/voice/index.ts` | Vendored Pi Voice sources (MIT; `LICENSE` beside them, origin recorded under **Voice (dictation) builtin**). `src/index.ts` registers the tool, commands and shortcut and loads `src/runtime.ts` lazily on first press; capture/transcription live in `dictation-controller.ts`, `transcription-service.ts` and `vad.ts` (dynamic native imports), the recording meter in `visualizer.ts` paints plain-text widget lines. Model setup is explicit and local; the agent must ask before any package-manager command. |
| `tern` | `extensions/tern-browser/extension.ts`; model-visible via `swarmSurfaceFor` in `.pi/lib/runtime/swarm-tool-gating.ts` | `.pi/lib/tern/browser.ts`: one agent tool for Tern browsers, panes and tabs, scoped to the caller pane's tab plus tabs this process created with `new_tab`. Browsers are regular signed-in ones (`open` focuses the target pane, runs `tern ctl browser open`, and tracks the one new block only if it lands in the target's tab; two new blocks at once is rejected). Ops: `list`; `new_tab` (optional absolute `cwd`, no command); `rename_tab` (only tabs it created); `open` (optional `block` target pane, default this pane); `blocks`, `goto`, `snapshot`, `act`, `capture` (browser blocks in scope); `split`; `focus`; `close` (only blocks it created: never this pane, never a user block). Ownership is in-process memory: after `/reload` agent-created blocks are readable but not closable. No session, cookie or profile operations, no arbitrary commands, no pane move. Subprocesses take the cancellation signal and report bounded errors. Unit: `npx vitest run .pi/test/tern/browser.test.ts .pi/test/tern/browser-handler.test.ts`; live: `npx vite-node tools/e2e/tern-browser-harness.mjs` (needs `TERN_PANE`). Runtime detection: `detectBackendSync()`/`probePaneRuntime()` (`.pi/lib/panes/install-probe.ts`) prefer the native runtime and otherwise fall back to herdr (`.pi/lib/panes/herdr.ts` over its CLI/socket API, numeric facade over its string pane ids, ownership enforced per process). On a fallback the schema carries only `PANE_OPS`, so no advertised op can fail by construction; with no runtime the tool is not registered and `/pane-runtime` plus one dismissible session-start prompt (`.pi/lib/ui/pane-runtime-setup.ts`) offer the install. Unit: `npx vitest run .pi/test/panes`; live: `HERDR_LIVE=1` with a running `herdr server`. |
| `enter_plan_mode`, `exit_plan_mode` | `extensions/swarm-plan-mode/extension.ts` | `.pi/lib/context/swarm-plan-mode.ts`; plan approval is separate from implementation. |
| `/auto on|off|status` | `extensions/swarm-auto/extension.ts` | Opt-in session-local autonomous continuation. Contributes `auto:on/off` through the existing `pi-swarm-footer-segments` registry; it never replaces the footer slot. Ask-user now uses the replacement interactive questionnaire; the former ask tool’s automatic consultation is not supported. `before_agent_start` supplies bounded branch and tracked-worktree context; settled `agent_end` follows an explicit progress marker only while idle. No global provider limits or policy gates are changed. |
| `ask_user_question` | `extensions/ask-user/extension.ts` | Ask-user uses `eko24ive/pi-ask` at commit `49482b7e5d0d57be8af1db81f490f6e860792cfb` (MIT; LICENSE beside it). Private implementation, docs and tests live within `extensions/ask-user/`. The canonical tool name remains `ask_user_question` with the new questionnaire schema. |
| OSC 7501 program status | `extensions/swarm-program-status/extension.ts` | `.pi/lib/runtime/program-status.ts` emitter; terminal-native status reports (idle/working/blocked/done/error/clear) over stderr for terminals, multiplexers, and agentic inboxes. `ask_user_question` maps to `blocked` kind=question. Disabled with `TREBOL_PROGRAM_STATUS=0`. |
| `control_plane_status` | `extensions/control-panel/extension.ts` | `packages/runtime/runtime-contracts/src/control-plane.ts`, `control-plane-store.ts`; dashboard is read-only. |
| `daemon_status`, task/run tools | `extensions/control-task-tools/extension.ts` | `packages/runtime/runtime-contracts/src/daemon-rpc.ts`, `control-task.ts`; unavailable daemon must fail closed. Daemon goal/loop APIs remain available to non-TUI consumers, but are not registered in the TUI. |
| `scheduler`, `/goal`, `/loop` | `extensions/swarm-goal/extension.ts` | `.pi/lib/tools/swarm-goal.ts`; session-local scheduling and evidence-based goal continuation without a turn cap. Replaces the separate CronCreate/List/Delete and ScheduleWakeup TUI tools. It also exposes a `GoalHost` control surface (`establish`/`widen`/`clear`/`status`/`observe`) that Claw drives for every worker's always-on completion goal: Pi gives each extension its own API object *and* its own module instance (measured), so the host is published on `globalThis[Symbol.for("pi-swarm-goal-hosts")]` keyed by session id (`goalHostForSession`) — a module-level WeakMap is not visible across extensions. Establishing before the goal extension registers does not queue: the worker reports the goal `unavailable` instead. See `docs/claw/README.md`. |
| `/upgrade`, `/upgradegoal` | `extensions/upgrade-prompt/extension.ts` | `.pi/lib/tools/swarm-goal.ts` via the same session-keyed `goalHostForSession`/`establishGoal` surface Claw uses, so `/upgradegoal` needs the `swarm-goal` extension loaded in the same process. The `/upgrade` wrapper is both the goal condition and the submitted turn — one template, no drift — and the goal is established before the turn is sent. Empty input, a condition over the 4000-character goal limit, an already-active goal, and a missing host each refuse with a warning and send nothing, because degrading to a plain upgrade would leave the user believing a goal is running. Unit: `.pi/test/tools/upgrade-prompt.test.ts` (the goal host there is the real `registerSwarmGoal`). |
| Session wake-up delivery | `.pi/lib/runtime/session-wakeup.ts` | Background-agent completion and swarm-goal share custom-message delivery with triggerTurn, generation guards, and shutdown invalidation. No runtime imports from vendor. |
| `/claw`, `claw_spawn`, `claw_list`, `claw_read`, `claw_send`, `claw_cancel`, `claw_trigger`, `claw_set_keep`, `claw_close`, `claw_resume`; worker `claw_finish`, `claw_goal` | `extensions/claw/extension.ts` (orchestrator tools and `/claw`; worker gate plus `claw_finish`/`claw_goal` when `PI_CLAW_RUN` is set) | `.pi/lib/claw/`: `store.ts` (file state; runs, triggers and inbox items carry the owning orchestrator session and its Tern pane, and each session has its own inbox cursor under `.swarm/claw/sessions/`, so several Claw sessions share one workspace and daemon without receiving each other's runs), `inbox.ts` (per-session delivery), `spawn.ts` (launch phases, task file, derived goal, `launchPrompt`), `upgrade-prompt.ts` (the `/upgrade` template, shared with `extensions/upgrade-prompt`; a fresh worker's first turn is that template around its task-file line unless the run has `upgrade: false`), `goal.ts` (always-on completion goal state, brakes, resume generations), `resume.ts` (keep-open reachability and relaunch on the recorded session), `daemon.ts` (singleton reconciler, goal events, one long-run warning), `launcher.ts` (Tern, `--session` for a resume), `preflight.ts` (launch gate), `supervisor.ts` (the single tab-close point, which honours `keepOpen`), `child.ts` (worker events). A worker's goal is derived from its task and established after launch in its own process, never in the launch prompt; it has no cap or deadline and ends only on MET, IMPOSSIBLE, `claw_finish` (cleared before the report), a question, cancellation or a terminal state, and a `claw_resume` arms the next generation of it. Docs: `docs/claw/README.md`; live: `node tools/e2e/claw-goal-always.mjs`; two sessions as two processes: `node --experimental-strip-types tools/e2e/claw-two-orchestrators.mjs`; mutations: `node tools/claw/mutation-check.mjs`. |
| `vault_add`, `vault_approve`, `vault_exec`, `vault_list`, `vault_two_person_status` | `extensions/swarm-history-vault-tools/extension.ts` | `.pi/lib/tools/swarm-vault-tools.ts`; never expose secret values. |
| `vault` | `extensions/vault/extension.ts` | `.pi/lib/tools/swarm-vault-tools.ts`; transparent global credential storage, with explicit user-risk warning. |
| `mcp__<server>__<tool>` | `extensions/mcp-fallback/extension.ts`, `extensions/swarm-websearch/extension.ts` / `packages/tools/mcp/src/index.ts` | Provider-neutral declared MCP bridge; manifests, allowlists, transport, and auth are the seam. |
| `annoyed` | `extensions/annoyed/extension.ts` | `extensions/annoyed/store.ts`, `.pi/lib/tools/swarm-annoyed-routing.ts`, and `swarm-annoyed-publish.ts`; a tool-less ownership judge routes project reports only to a verified active-workspace GitHub remote and Trebol triages upstream/non-actionable/uncertain/judge-failure/missing-remote cases. Publication receipts are SQLite metadata with a stable remote marker; ambiguous results are never blindly retried and SQLite/GitHub is not exactly-once. Transcript stays local; nudge behavior remains separate. |

Model-facing Swarm prompt text lives in `prompts/swarm-system-prompt.md`, the
single editable source for the Forge text, runtime directives, and section
order. Tool captures remain reference snapshots; local wording intentionally differs where blanket
workflow restrictions would prevent useful work. Preserve tool limits, approval
requirements, and data-integrity rules when changing this adapter.

Names may be filtered by active-tool policy. `swarm-tools-status` and
`system-inspector` show the runtime's actual registered/active surface; use
those instead of assuming every row above is enabled.

Paseo integration is currently Linux-only for managed process ownership checks
(`.pi/lib/tools/paseo-setup.ts`, adapted by `extensions/paseo/extension.ts`). New launches default to loopback and use
per-user state under `$XDG_STATE_HOME/pi-swarm/paseo` (default
`~/.local/state/pi-swarm/paseo`). Existing owned PID records are checked before
launch, subprocesses are bounded, and daemon health includes HTTP validation.
`/paseo setup inspect` only inspects Tailscale. Explicit `/paseo setup apply` (or a tool
setup call with `apply: true`) discovers the machine hostname, merges `daemon.hostnames`,
hot-reloads the daemon, and creates an unoccupied persistent tailnet-only Serve
route. Session startup only starts/checks the daemon, never changes network
exposure. `/paseo setup apply` retries the same operation. Existing conflicting routes or
Funnel exposure fail closed; matching routes are reverified without replacement.
Success requires HTTPS health plus a WebSocket hello/status/pong handshake.
`PASEO_HOME` is injected into managed launches. Config writes are atomic and mode
0600, anchored to verified Linux directory descriptors; setup/start/stop/update/build
share a lock. Update/build refuse live daemon records; stop retains records until
termination is verified. Interrupted locks require inspection, not age-only
automatic stealing. This is not yet an unattended cross-platform
installer or boot-time service. Fresh global package clones do not include a
built Paseo submodule. Validate with `npx vitest run .pi/test/tools/paseo.test.ts`;
those tests do not prove process supervision or cross-device connectivity.

The PageIndex-style context adapter registers `context_index`, `context_remember`,
`context_reindex`, `context_search`, `context_outline`, `context_read`,
`context_inspect`, and `context_delete`; these are retained by the default tool
surface. Session reload accepts Pi custom-entry envelopes. Retrieval consultations
use tool-disabled Pi subprocesses; selected sections are materialized by the
parent. `context-consult.ts` limits elapsed time and accepted output, but Pi's
exec API buffers child output internally (peak memory is not streaming-bounded).
The context index still has session scope; cross-session knowledge integration
is unfinished. `.pi/lib/state/knowledge-store.ts` and
`.pi/lib/context/knowledge-capture.ts` are tested integration components. `knowledge-recall.ts`
(used by `memory_history`) projects verified durable records into cited PageIndex
reads; candidate records are excluded, storage failure is distinct from no match,
and recall now ranks all current scoped records from a single event-log projection before applying the response cap. `memory_history` supports `get` by scoped ID and status-filtered search for
candidate review. Review instructions require source evidence and later
corrections before revision-checked verification; extraction alone is not proof.
New non-session `memory_history` writes now use this store; legacy records remain
readable and labeled unverified. Correction/deletion require revision checks.
Agent global writes fail closed. `/memory-promote repository|worktree ID [namespace]`
requires interactive confirmation of a verified record and rechecks its revision
before making an explicitly approved global copy; the project record stays intact. Lifecycle candidate capture is registered in `knowledge-enrichment.ts`: on
`agent_settled` and `session_before_compact`, it processes new visible evidence,
persists a `pi-swarm-knowledge-enrichment` cursor, and saves cited candidates.
It excludes reasoning/runtime reminders and suppresses child-agent capture.
`/memory-capture on|off|status` controls this per session;
`PI_SWARM_MEMORY_CAPTURE=off` disables it initially. Consultations are awaited
and may add up to their timeout to turn completion. `candidate-memory-review.ts`
reviews at most one pending record per settled turn (or `/memory-review`) using
`PI_SWARM_MEMORY_REVIEW_MODEL` (default `clover-plexus/luna`). It reads only cited
Pi session entries, requires a bounded model verdict with a source-matching
quote, and corrects the existing record by exact revision; failed review leaves
it candidate. This is a model judgment, not independent proof, and it never
writes global scope. `task-candidate-capture.ts` projects TaskManage's current
task snapshot into worktree-scoped candidates: each record includes every task
question, answered or unanswered, plus answer/evidence when present. Repeated
snapshots are idempotent and changed answers create revisions; the per-task
record is never verified. In addition, each answer of a *completed* task becomes
its own `kind: fact` record (source `taskmanage-answer:<session>:<task>:<question>`,
text `Q:/A:/Task:`). `.pi/lib/state/answer-evidence.ts` anchors its evidence at
capture: `path#Lx-Ly` stores the redacted span text, `file.md#Heading` the
heading line, `tool:Name#n` the cited session entry (`<session>.jsonl#<id>`) and
a result excerpt, and a bare path is existence-only. The record is `verified`
iff at least one anchored ref exists and every ref resolved; otherwise it stays
candidate with the unresolved refs and reasons in its text. Anchors are frozen at
first capture. Paths are stored relative to, and bounded by, the git worktree
root (the same identity that keys the worktree store), so recall from any
subdirectory re-checks the same file; other worktrees do not see these records.
`recallKnowledge` re-checks file spans/headings of
answer records on every read and drops changed ones as `staleExcluded`.
"Verified" here means the cited evidence is unchanged, not that the answer is
correct. E2E: `node tools/e2e/taskmanage-answer-memory.mjs` (real Pi, scripted
provider; 9 steps including subdirectory recall, uncited-edit near miss and cited-edit stale).
Unverified candidates remain excluded from `recallKnowledge`. `context_search` can report candidate-leads on a session
index miss, with Q&A projected as Markdown sections rather than raw JSON.
`memory_history` operation `recall` invokes a bounded read-only memory agent
using `PI_SWARM_MEMORY_RETRIEVAL_MODEL` or the session model (Luna fallback),
and returns selected source cards, not the child agent's prose. The sibling
`memory_history` operation `ask` uses the same scoped PageIndex projection and
isolated browse/read/select child, but requires the child to submit a bounded
answer citing its read/selected card keys. The parent validates the receipt
and returns the answer alongside original record IDs, revisions, statuses and
citations. An empty index or unsupported answer returns no answer; a failed or
malformed child is reported distinctly. Candidate cards remain unverified
leads; `ask` neither writes nor changes `recallKnowledge`'s verified-only recall.
When the isolated child submits a receipt but later exits nonzero or times out,
the parent still validates that committed receipt; without one, it returns
`unavailable`. Abort and session-generation checks still reject stale results.
The `ask`/`recall` model-visible text now leads with outcome and answer (or
explicit no-answer), then bounded source-card IDs, status, excerpts and
citations; structured `details` retain the full prior retrieval result.
Other memory operations retain their JSON text. The tool's TUI-only renderer
shows a compact outcome/answer and an expanded source view without repeating
the raw JSON or changing retrieval state. Reload to update an active session.
The opt-in synthetic `live-answer.mjs` run enables child-only metadata tracing
(`PI_SWARM_MEMORY_RETRIEVAL_TRACE=1`) and saves offered cards, ordered
browse/read/select events, receipt, exit and final tool response under ignored
`artifacts/memory-retrieval/live-answer-*/results.jsonl`. Normal retrieval
does not emit these traces; they are not added to model-visible results.
`offer` lets the main agent hand explicit “remember that” content to a
tool-less reviewer for a durable candidate and indexed acknowledgment. Existing
`get` and other write operations retain their contracts. `search` with a query is ranked
(`.pi/lib/state/fact-index.ts`): exact phrase matches first, then BM25 over
any query term fused (RRF k=60) with dense embeddings when
`PI_SWARM_MEMORY_EMBED_URL` points at an OpenAI-compatible embeddings server
(e.g. a tunnel to spark embeddinggemma; vectors cached per revision in the
store's `embeddings.jsonl`; failure degrades to BM25 and is reported as
`embedError`). It does not automatically include another scope. Benchmark:
`artifacts/memory-bench/PREREG.md`, `tools/bench/retrieval-bench.mjs`. `recall` ranks strict PageIndex section matches first
and fills unused candidate slots with partial matches containing at least two
distinctive terms; the read-only agent still decides whether they support the
query. A typo or synonym without lexical overlap may still return no result.
Historical backlog review is incremental. Store path checks reject
existing symlinks; hostile concurrent ancestor replacement is outside its current
filesystem guarantees. No live backfill is implied by these library tests.

Memory/skill semantics are shared in `.pi/lib/context/memory-guidance.ts`.
Memory stores project/domain knowledge, decisions and rationale, preferences,
and contextual facts (including how a project operates); skills store reusable
agent procedures. Mixed observations must be separated, not copied wholesale.
Repository is the shared-memory default; worktree holds unmerged facts, session
holds local context, and global requires explicitly shareable cross-project
knowledge. Do not automatically duplicate facts across scopes. The PageIndex-style
context extension currently retains its namespace/workspace/session boundary.

Knowledge enrichment is explicit and evidence-backed after verification, not
automatic transcript ingestion. No new learning is a valid outcome. Historical backfills must be reviewed, scoped, and redacted before
promotion; experimental stores use `PI_SWARM_MEMORY_DIR`.

### Skills and their locations

| Skill source | Location | Owner / notes |
| --- | --- | --- |
| Builtin `loop` | `packages/context/skills/builtins/loop/SKILL.md` | `packages/context/skills/src/index.ts` loader; progressive disclosure. |
| Builtin `swarm-skill` | `packages/context/skills/builtins/swarm-skill/SKILL.md` and `references/SKILL-AUTHORING.md` | Skill authoring contract. |
| Builtin `swarm-workflow` | `packages/context/skills/builtins/swarm-workflow/SKILL.md` and `references/` | Workflow schema, profiles, examples, strategies, troubleshooting. |
| `ask-user` | `extensions/ask-user/skills/ask-user/SKILL.md` and `references/` | Carried with the forked `ask_user_question` extension; deliberately not registered as a builtin so the parity-compared `<available_skills>` block is unchanged. |
| Autogenerated/project/user/managed/install skills | Runtime search paths resolved by `packages/context/skills/src/index.ts` | Do not hard-code paths; `swarm-skills.ts` exposes source and support files. |
| Autogenerated skill lifecycle/revisions | `extensions/autogenskills/extension.ts` + `packages/context/autogenskills/src/index.ts` | Curator, locks, budgets, review/absorb/archive/pin. |
| Local harness skill | `.swarm/skills/pi-harness-engineering/SKILL.md` | Runtime state/configuration; do not mistake it for a builtin package skill. |

If changing skill discovery, loading, precedence, progressive disclosure, or
support-file safety, change `packages/context/skills/src/index.ts` and its tests first; change
the Pi adapter only for registration/presentation concerns.

### Hooks and lifecycle locations

| Hook group / concern | Registration | Implementation / events |
| --- | --- | --- |
| Central hook state and ordering | `.pi/lib/runtime/hook-state.ts` | Registration, enablement, persistence, and visibility. |
| Same-session hook correction | `.pi/lib/runtime/hook-correction.ts` | Authoritative tool_call denial with same-step feedback; repeats only change the guidance text. A block result must never set `terminate` (Pi ends the run on it); guarded by `.pi/test/tools/hook-block-never-stops.test.ts`. No speculative abort or settlement wake. |
| Prompt hook `packages/context/prompt` | `extensions/swarm-prompt/extension.ts` | `before_agent_start`; prompt/context assembly in `packages/context/prompt/src/index.ts` and `.pi/lib/context/swarm-context.ts`. Default base prompt is **Modes Agent** (`prompts/modes-system-prompt.md`, byte-identical to the benchmarked `artifacts/prompt-bench/arms/M.md`; `{{workspace}}` rendered per cwd, sudo section removed); it beat Forge in the sealed confirmatory run (M−F +0.227 [+0.107, +0.360], `artifacts/prompt-bench/confirm/FINDINGS.md`). `/system-prompt` still selects Forge Swarm Agent, Pi base, or saved prompts; a stored `activePrompt` wins. Footer explanation guidance is Forge-only. E2E: `node tools/e2e/modes-default-prompt.mjs`. |
| Disk hooks `disk-hooks` | `extensions/swarm-disk-hooks/extension.ts` | Loads project/user hook config, executes bounded commands; maps tool/session/prompt/compact events. |
| Structure guard `structure-guard` | `extensions/project-init/extension.ts` | `tool_call`; denies `write`/`edit`/`apply_patch` *creations* that violate `.project/structure.json` before the tool runs. Policy and classification in `.pi/lib/policy/project-structure.ts`, tool-argument extraction in `structure-guard.ts`. Existing paths are never blocked; `PI_SWARM_NO_STRUCTURE_GUARD=1` disables it like `PI_SWARM_NO_HOOKS`. |
| Inline hook presentation | `extensions/hooks/extension.ts`, `.pi/lib/runtime/hook-render-bridge.ts`, `.pi/lib/runtime/hook-presenter.ts` | UI only; never make governance depend on rendering. |
| Program status (OSC 7501) | `extensions/swarm-program-status/extension.ts` | `.pi/lib/runtime/program-status.ts`; `session_start`/`session_switch`→idle, `before_agent_start`/`turn_start`→working, `ask_user_question`→blocked(question), `agent_before_settle`→done/error, `session_shutdown`→clear. |
| Annoyance/nudge | `extensions/annoyed/nudge.ts` | `tool_result`, `turn_end`; persistence in `annoyed/store.ts`. |
| Task enforcement | `extensions/taskmanage/extension.ts` | `packages/tools/taskmanage/src/task-hooks.ts`, `swarm-hook-runtime.ts`; task state is authoritative in taskmanage. |
| Metrics/cache telemetry | `extensions/conversation-metrics/extension.ts`, `cache-telemetry.ts` | Agent/message/provider lifecycle; persisted telemetry is non-secret. |
| Theme/thinking/UI lifecycle | `extensions/swarm-themes/extension.ts`, `swarm-thinking.ts` | Presentation/config only. |

For a hook bug, first identify the Pi event (`before_agent_start`, `tool_call`,
`tool_result`, `turn_start/end`, `session_start/shutdown`, or compaction), then
the hook group, then the domain owner. Hook execution, policy, and rendering
are separate seams and should remain decoupled.

### Package source locator

| Package | Primary source files | Change here when… |
| --- | --- | --- |
| `packages/tools/agents` | `packages/tools/agents/src/index.ts` | Agent identity, runner, cancellation, concurrency, or child sessions change. The Absurd daemon, control plane and general-agent adapter live in `packages/experimental/absurd-worker`. |
| `packages/context/autogenskills` | `packages/context/autogenskills/src/index.ts` | Skill curation, locking, budgets, revision history, or review policy changes. |
| `packages/tools/mcp` | `packages/tools/mcp/src/index.ts` | MCP manifests, transports, discovery, tool allowlists, or auth change. |
| `packages/runtime/runtime-contracts` | `packages/runtime/runtime-contracts/src/*.ts` | Control-plane, daemon, goal-loop, task, or stable runtime interfaces change. |
| `packages/tools/schedule` | `packages/tools/schedule/src/{cron,scheduler,store,tools,types}.ts` | Scheduling semantics, persistence, or schedule tools change. |
| `packages/context/skills` | `packages/context/skills/src/index.ts`, `packages/context/skills/builtins/**` | Skill loading, precedence, builtins, metadata, or disclosure changes. |
| `packages/runtime/core` | `packages/runtime/core/src/tool-renderer.ts` | Shared tool rendering changes. |
| `packages/context/prompt` | `packages/context/prompt/src/index.ts`, `prompts/swarm-system-prompt.md` | Canonical prompt text, section order, or prompt provenance changes. |
| `packages/tools/taskmanage` | `packages/tools/taskmanage/src/*.ts` | Task persistence, hooks, workflows, interaction, or authoritative task lifecycle changes. |

Tests live beside each package in its `test/` directory and under
`.pi/test/<layer>/` for extension and library behaviour; one root
`vitest.config.ts` runs both. Update both sides when a public contract crosses
the package/extension boundary.

## Package boundaries

- `packages/context/prompt` owns prompt precedence, workspace context, and non-secret
  provenance; chain `event.systemPrompt` instead of overwriting blindly.
- Tool registration or a prompt instruction is not authorization: the gate lives in the tool
  implementation under `.pi/lib/tools/` (`path-guard.ts` holds the path boundaries).
- `packages/tools/taskmanage`, `packages/tools/agents`, `history-search`, and `memory-history` own their
  respective durable workflows; use stable IDs and bounded outputs.
- `packages/runtime/core` exports only the shared tool renderer. Session identity and lifecycle
  belong to Pi; extensions must not invent global identity or duplicate lifecycle state.
- `packages/context/skills`, `packages/context/autogenskills`, `packages/tools/mcp`, and `packages/tools/schedule` provide opt-in capability
  layers; do not make ambient discovery silently widen a closed profile.
- `packages/runtime/runtime-contracts` defines interfaces consumed by multiple packages; change it
  deliberately and update all consumers/tests.
- Import direction is fixed by who runs the code. `.pi/` imports package
  sources by relative path (`../../../packages/<layer>/<name>/src/index.ts`):
  Pi loads extensions through jiti with plain Node resolution and no build
  step, so a bare `@pi-swarm/<name>` import there would silently depend on a
  stale or missing `dist/`. Package-to-package imports use the bare workspace
  name (`@pi-swarm/core`, `@pi-swarm/runtime-contracts`) against that
  package's `dist` exports so `tsc` `rootDir` boundaries hold. Do not mix the
  two; `tools/repo/rewrite-imports.mjs --check` verifies the relative side.

## Change contract

Every agent must:

1. Read this file and inspect `git status --short` before editing.
2. Create/update a TaskManage task for multi-step work and keep its status
   current.
3. Identify the owning package/extension before changing code; avoid unrelated
   refactors and preserve existing user changes.
4. Update this file's index, inventory, package boundaries, or flow whenever
   files, ownership, commands, extension registration, or architecture change.
5. Add focused tests for behavior changes where practical, and document any
   intentional test gap.
6. Report files changed, validation run, and known limitations.

When adding a new top-level package, extension, persistent entry type, hook
group, or user-facing command, add it to the relevant tables above in the same
patch. This is a contract, not optional documentation.

## Tern work

Conversation input in `.pi/lib/tern/bridge.ts` follows native Pi: ordinary Enter
while busy queues **steering** for the next agent boundary; Alt+Enter queues a
**follow-up** until the agent yields. Queue rendering follows Pi's `queue_update`.
`agent_end` ends an attempt, not necessarily the active session run: retain busy
while `session.isStreaming` is true until `agent_settled`. Regression coverage:
`.pi/test/tern/bridge.test.ts` and `tools/e2e/tern-queue-delivery.mjs` (real Pi,
loopback scripted provider). Restart the pane runner to load bridge changes.

Whenever work touches or adds a Tern-related feature (for example
`.pi/lib/tern/`, `tern-plugins/`, `extensions/tern-resume/`, or
`tools/e2e/tern-*.mjs`), fetch and read
https://docs.stencil.so/tern/index.md first, before planning or editing.

### Live work rendering contract

The transcript's turn card (`.pi/lib/tern/bridge.ts`, `work-summary.ts`) is a **data** projection, not a
hand-drawn table. Tern 0.9.5 draws and *clocks* the parts that change every second:

- One native `tool` head per tool call, in call order, nested in the turn card (a nested `tool` draws
  unframed). A step carries its verb and a typed `target` (`path` for file tools, `pattern` for searches);
  a Bash step carries **no verb**: `bashLabel` gives description -> caller name -> bounded command, so the row
  reads as the job, never as "Bash <command>". `status`, `age` while running / `took` once settled, `exit` and
  `note` stay in the head. Tern spins the glyph and counts `age` on its own, so **never** re-render on a timer
  to advance a clock and never hand-format an elapsed row.
- The group head follows the work, not the prompt: title is `N running` / `working` / `Done`, and its target
  is the newest running tool call's label while live, else the last call's label (including once settled).
  Never put the user request there — it stays in the user bubble. `age`/`took` is the turn's own clock, and a
  recovered failure is a `warning` badge (`1 failed`). The tracked task is the only extra heading line.
- A running step is **open** over a bounded live window (`tailWindow`, `STEP_LIVE_LINES`); a settled step is
  folded to its head, and Ctrl+O opens every step. Do not clamp with a `tool` `preview`: Tern's previews give
  way inside an open tool, and removing a preview does not re-fold a step, so the body would stay visible.
- The dock carries the turn too: an `elapsed` (`omp.composer.turn`) sits beside Stop only while busy, and a
  fact chip with no reachable action is a plain label (`modelSelectable`), because a click that can only write
  "unavailable" into the transcript is a trap.
- A Bash step's label is the **description** (else the caller's name, else the bounded command), `title` is
  empty, and opening it shows the command (`code`, role `omp.tool.bash.command`) before the output, because
  the label is intent. When the label already is the whole command, the body is output only, so nothing is
  duplicated. The exact command stays in `command` for the head's Copy. The one `.sf-tool-hr` between command
  and output is Tern's section rule and is intentional; there is no `omp.run` box and no state foot.
- An `apply_patch` is a diff, not a status word: `patchSections` splits the V4A body per file (dropping the
  `***` markers), the head names the files with `+a −d`, and each file draws a Tern `diff` node. Folded once
  settled, like every other step.
- The card body is one `col` (`tern.work-body`, `gap: "sm"`), so steps read as a tree by indentation and Tern
  never draws its kind-change hairline (`.sf-tool-hr`) between a step and its neighbours. `work-style.ts`
  hides the nested `.sf-tool-ic`: the card head owns the turn's glyph, each step is named by its label (Bash:
  the description). Steps are indented 18px and their bodies 12px more, so depth is the only guide. Keep every selector
  inside Tern's subset (no `:has()`, no `~`, no leading region element). The one control is the muted
  `Inspect steps` text line at the end of the tree; do not add a chip row back.
- Text in program sheets follows the terminal font: write sizes as `calc(var(--sf-fs, 13px) * N / 13)`, never
  plain `px`. Tern documents a 13px design zoomed by `font / 13`, but the Tern 0.9.5 Linux desktop view sets
  `--sf-fs` to the raw font with no zoom, so plain px (ours and Tern's own composer rules) froze there while
  headless `tern serve` zoomed correctly. `composer-style.ts` therefore restates the composer's text sizes;
  the `[data-scope]` prefix adds no specificity, so each override matches the chat skin's specificity through
  role ancestors (`omp.composer.bar`, `omp.composer.line`). `dock.test.ts` pins this. Verify font changes in
  the desktop window, not only headless, with `tern ctl dump <selector>` at two `tern ctl font` sizes.
- Markdown callouts are theme-neutral: `.pi/lib/tern/markdown-style.ts` (sheet `markdown`) replaces Tern's
  `--accent` fill with a `--l3` hairline and quiet icon; only warning/caution keep `--warn` on rule and icon.
  Mermaid figures are one opaque `svg`, so diagram look is steered through the `mermaid` prompt section
  (flowchart + labelled subgraphs and role shapes; no `architecture-beta`, `C4*` or `classDef` fills), not CSS.
  Evidence and mockups: `ideas/tern-markdown/`.
- The ask dialog is a **form**, so its card is solid: `.pi/lib/tern/ask-style.ts` (sheet `ask`, registered in
  `start()` because a flow can be the pane's first frame) feeds Tern's `--sf-card-bg` with `--card`, falling
  back to `--fog`, inside `.sf-card[data-role='pi.ask']`. Tern's card is glass (white 55% light, white 2.8%
  dark), which made the question and the panel behind it the same colour and let a glass window show through.
  Feed the token, never paint `background` (a tone fill still resolves through it), and never drop the role
  scope: every other card keeps its glass. `--page`/`--panel` are not fallbacks — the kit calls them
  translucent in glass windows. Verify with `node tools/e2e/tern-ask-card-surface.mjs`: a real `tern serve`
  reports the computed fill in light and dark, checks in the same run that a role-less card is still glass,
  and `--no-sheet` reproduces the pre-fix translucency.
- Subagents are `agent` nodes in the background card (`stats.age`, `stats.tokens`, `task`), and a TaskManage
  batch is one `checklist` (a blocked operation is a `blocked` item whose `note` is its error). Only fields
  the running-work store and the batch really carry are sent; no invented progress, context or cost.
- `diffChildren` in `.pi/lib/tern/tsp.ts` matches children **by id** and reorders with `move` ops. A
  positional diff deleted and re-added every sibling after an insert or removal, which threw away the
  terminal-side state (local fold, ansi scroll, highlighted block) and repainted the card on every settle.
  Keep id matching; text that only grows must still go out as `text append`.
- Keystroke cost must not grow with session length. Every input re-renders the surface, so
  `TranscriptProjector.nodes` memoizes settled segments (a live group, or one with a running step, is
  rebuilt every time because it reads `Date.now()`), and `diffNode` skips subtrees that are
  reference-equal. A cache entry is valid only while its inputs are `===` and every item is shallow-equal
  to its snapshot, so **replace** item fields (`item.artifacts = …`), never mutate nested values in place.
  Reused nodes must never be mutated after `nodes()` returns. Gate: `.pi/test/tern/bridge-perf.test.ts`
  (a scaling check, a wire op-replay oracle and a memo-versus-fresh oracle); `TERN_PERF=1` prints the
  per-keystroke table up to 1000 turns.
- The transcript renders a **window**: a resumed session opens on its last `TRANSCRIPT_WINDOW_TURNS` (50)
  turns behind one `transcript-earlier` row (action `transcript.earlier` adds 50 more), and a live session
  is trimmed back to 50 once it passes `TRANSCRIPT_TRIM_TURNS` (150) unless the user asked for older turns.
  The window always starts on a turn boundary, so segments and group ids are the same as for the full
  transcript; `revealStep` widens it to reach a hidden step.
- Look up items with `TranscriptProjector.item` / `callItem` (searched from the newest), never a forward
  `find` over `#items`: that made restoring a session O(n²). Tool items are keyed through `#callItems`
  because some providers restart call ids per message (`call_0`, …); a repeat gets `t-<callId>~n`.
- Long runtime: a step keeps at most `OUTPUT_KEEP_CHARS` (256 KB) of output, the tail behind
  "… N earlier lines not kept" (counted incrementally per streamed update), copied off its parent string
  once settled; `errorText` is bounded the same way and artifact blobs drop their bytes once sent. Set
  output through `keepOutput`, never `item.output = …` directly. Soak: `node --expose-gc
  tools/perf/tern-bridge-soak.mjs [turns]` prints keystroke cost and retained heap as the run goes.
- TSP chunking counts UTF-8 bytes arithmetically (`codePointBytes`); never allocate per character there.
- Measure on real sessions and constrained hosts with `node tools/perf/tern-bridge-bench.mjs <session.jsonl>`
  or `--turns N`, e.g. under `systemd-run --user --scope -p CPUQuota=10% -p MemoryMax=512M node
  --max-old-space-size=96 …`. Per-render work is about 0.13 ms; a Rust/N-API addon would pay more than that
  just serializing the view across the boundary (0.22 ms at 1000 turns), so keep this path in TypeScript.

Visual check without a model: `node tools/e2e/tern-live-work-demo.mjs` renders one scripted turn
(`EXPAND=1` = Ctrl+O, `SPEED=n` = slower) into its own pane; `tern ctl shot <name>` writes
`target/shots/tern/live/<name>.png` to look at. Behaviour is asserted by
`.pi/test/tern/work-table.test.ts`, `turn-work.test.ts`, `turn-groups.test.ts` and `tsp.test.ts`.

### Git panel contract

The composer's git segment opens a full Tern sheet (`overlay size: "full"`) built in
`.pi/lib/tern/git-panel.ts`. It follows OMP's **native** git app (`GitTuiComponent.describe()` in
`packages/tui/src/apps/git/git-tui.ts` and `Sidebar.describe()` in `sidebar.ts`, v18.12.6), not the ANSI
`omp git` screen or the pinned `vendor/oh-my-pi` 18.1.14 submodule (which has no Tern frontend):

- The bar carries the selected path (`dim dir` + `strong base`), its `+a −d`, a scope badge, previous/next
  change, Unified/Split tabs, Stage/Unstage file, Discard, `?` and close. The body is Tern's `diff`; the side
  sheet has `N changes on main`, Path/Tree, Unstaged/Staged sections with Stage all/Unstage all, file rows
  (status letter, path, stats) and the commit composer (summary, description, Amend, Commit). A clean tree
  replaces the change sheet with the HEAD commit (subject, body, author, authored, parents, file list).
- Tern's `diff` supports `unified` and `split` only. OMP's File/Inline/Hunks views, per-hunk and selected-line
  staging, binary/media compare and AI staging are **not** reproduced, because Tern/Pi has no node or source
  for them; do not draw a button that cannot act.
- Reads go through `.pi/lib/tern/git-status.ts` with `--no-optional-locks`; only explicit panel actions
  (`stagePaths`, `unstagePaths`, `discardPaths`, `commitIndex`) may take git's locks. `readHeadCommit` uses
  `diff-tree --root`, or a repository's first commit lists no files.
- A Tern overlay never takes the keyboard, so raw keys still reach the composer path. `PiTernBridge.applyGitKey`
  runs before `applyEditKey` in `.pi/lib/tern/run.ts`; it owns the commit fields and OMP's `j/k`, `[/]`, `s/u`,
  `x`, `a`, `c`, `r`, `?` bindings, and `applyGitPaste` routes bracketed paste. Focus is sent with the frame's
  `focus` op; clicking the summary/description text swaps in the live `input`/`editor` and focuses it.
- A path with both staged and unstaged edits appears in both areas, as OMP does; untracked and conflicted files
  live under Unstaged. A resize re-renders the sheet, and below 100 columns the sheet stacks under the diff.

Tests: `.pi/test/tern/git-panel.test.ts` (node shape), `git-panel-actions.test.ts` (bridge actions and keys),
`git-panel-git.test.ts` (real git as the oracle for stage/unstage/discard/commit/HEAD). Visual:
`TERN_GIT_DEMO=1 GIT_DEMO_CWD=<repo> node tools/e2e/tern-git-panel-demo.mjs` in a pane, then
`tern ctl shot git-panel`; `HELP=1` opens the key sheet and `UNIFIED=1` starts unified.

### Session tree picker

`/tree` (a Tern builtin) and double Escape open `.pi/lib/tern/session-tree.ts`. It works from Pi's
`SessionManager.getTree()`, follows Pi's `tree-selector.js` semantics (filter ids, active branch first, indent
only at a fork) and hides hook bookkeeping, because hook `custom` entries are ~90% of a real session and the
leaf is almost always one. "You are here" is the last visible entry on the active branch. The primary action's
wording follows `AgentSession.navigateTree`: a prompt or custom message reopens in the composer, and anything else
becomes the leaf. Picker `items` must be an array; a map renders no rows. Tests:
`.pi/test/tern/session-tree.test.ts`. Visual: `TERN_LIVE_DEMO=1 SESSION=<file.jsonl> node
--experimental-strip-types tools/e2e/tern-tree-demo.mjs` in a pane, then `tern ctl shot` (shots land under the
Tern process's cwd, `~/target/shots/tern/live/`).

### Edit and Resend on your messages

A click on a user bubble (`card` role `pi.user`, action `message.focus`) shows `Edit · Resend · Copy`
under it. A right-click offers the same items (`edit-message`, `resend-message`, `copy`; the event's node id
names the message, as with `remove-attachment`). `.pi/lib/tern/message-actions.ts` resolves a bubble to its
Pi entry: a restored bubble's id is the entry id, and a live one (`m12`, `n3`) is matched by position against
`getBranch()` user entries, refusing when the counts differ. Both actions go through
`AgentSession.navigateTree(userEntry)` (leaf → parent), so nothing is deleted: the original and its replies
stay in `/tree` as a branch. Edit does not touch the session until send. The composer holds the text plus the
message's images as chips, a banner sits in the composer's `above` slot, and Esc restores the earlier draft
and attachments. Resend branches and re-prompts with the same text and images. Both refuse while a turn runs
(Pi's navigateTree throws while streaming). Tests: `.pi/test/tern/message-actions.test.ts`, run on a real
file-backed `SessionManager`. Live: `OPEN=chat` on `tools/e2e/tern-tree-demo.mjs` (it works on a temp copy
of the session) plus `tern ctl click '[data-id$="msg-<entry>.edit"]'`.

Measured check without a model: `npm run lint:tern` (`tools/tern/style-lint.mjs`) replays the recorded
fixtures through the real bridge into a headless Tern at four widths and reports spilled boxes, clipped
lines, off-scale type, sheet parse errors and deleted-then-re-added stateful nodes; Tern's own sheet bleed is
the only accepted measurement (`tools/tern/style-lint.baseline`). `npm run lint:tern:self-test` seeds each
defect and fails if a rule stays silent, so keep a green run honest by running it after changes to the
sheets or to the node shapes in `bridge.ts`.

### Extension keys and widgets in a pane

Tern owns the terminal, so Pi's own `interactive-mode.ts` never sees a key and
never builds an extension `ExtensionContext`. Two seams close that gap:

- `.pi/lib/tern/ext-shortcuts.ts` dispatches `pi.registerShortcut` chords. `run.ts` calls it
  **before** `keyEffect(sequence)`, so a registered chord is consumed and an unregistered one
  still edits the draft; typing never does both. It reads
  `extensionRunner.getShortcuts(getKeybindings().getResolvedBindings())` on every press, so
  `/reload` and session replacement take effect without restarting the pane, ignores kitty key
  releases (a release parses as its press and would run the handler twice), and reports a
  throwing handler as a transcript notice instead of losing the key loop. Chords Pi already
  binds are not in that map (the runner drops builtin conflicts), so Tern's own Escape/Enter
  handling is unaffected. `bridge.notice()` is the transcript line it reports through.
- `.pi/lib/tern/ext-ui.ts` `setWidget` accepts the plain-text form extensions use
  (`string[]`), sanitises it (ANSI stripped) and renders it as one `text` node with role
  `pi.widget` above the composer (`widgetNodes("aboveEditor")` in the dock frame). Component
  factories cannot render without a pi-tui owner and are refused with a notice naming
  `pi -nt`; a flow that answers itself still resolves.
- Exception: `ctx.ui.custom` panels built **only** from Pi dialog primitives (containers,
  `Text`, `Spacer`, rule-only borders, `SelectList`, `Input`, `AuthUrlComponent`; a view that
  swaps screens via a top-level `content` is walked) are projected by `.pi/lib/tern/tui-panel.ts`
  into a modal `overlay` (role `pi.panel`). The factory receives Pi's real `getKeybindings()`;
  Tern only draws, and every key/click is forwarded to the component's own `handleInput`, so the
  panel's logic runs unchanged. This is how the host `/mcp` manager (server list, enable/disable,
  project override, reconnect, tools, exposure, sign-in + redirect URL) works natively in a pane
  with no MCP state re-implemented here. List rows are tinted from the leading status word
  (`failed`/`needs`/`connected`/`disabled`/`connecting`). The panel reuses the prompt list/input
  ids, so the bridge's select/activate/edit routing reaches it; prompts it raises stack above it;
  pane close releases it. Anything else in the tree keeps the refusal notice. Verified against the
  real host extension by `.pi/test/tern/mcp-panel.test.ts`.

That is what makes `extensions/voice` usable in a pane: `Ctrl+Space` now toggles capture, the
recording meter (`█` bands, elapsed time, model state) paints above the editor as it ticks, and
`/voice` works because the slash palette lists extension commands. Its `ctx.ui.custom` panels —
`/voice-settings`, onboarding, the model/microphone/recommendation pickers, the shortcut
recorder and the try-it pane — are exactly the refused case, so configure voice with `pi -nt`
or by writing `pi-voice.json`. Verified by `.pi/test/tern/ext-shortcuts.test.ts` (6 cases) and
`.pi/test/tern/voice-surface.test.ts` (meter node, escapes stripped, in-place update, removal,
refusal); the full Tern suite is 39 files / 514 tests.

### Session durability in a pane

Tern's session daemon owns pane pseudoterminals, so closing a **window** only detaches and the runner
keeps running; closing the **pane**, quitting `pi`, `/new`, a Tern-only restart or a machine crash ends it.
Pi's JSONL survives all of those, but resuming is deliberately narrow: **only a start after the machine
went down reopens the conversation.** `.pi/lib/tern/startup-session.ts` records which session each
`TERN_PANE` owns (`~/.pi/agent/tern-panes.json`, with the owner pid and the boot generation), and
`chooseStartupSession` reopens it only when the record came from an earlier boot, its file still exists and
no live runner owns it. Everything else — a pane that outlived its program in this boot, a forgotten
record, `PI_TERN_FRESH=1`/`PI_TERN_RESUME=0` — starts a new conversation, because a resume the user did not
ask for is the worse failure. There is no "most recent session for this directory" fallback. Records
without a boot generation are dropped, and Pi deletes a session that never held a message, so a record can
outlive its file (reason `missing`). `/new` runs through the runtime (`newSession` bridge option) and the
rebound session is recorded, so the pane leaves the old conversation behind immediately.

`bridge.start()` seeds the transcript from `getBranch()`, so a reopened pane draws its history on the first
frame instead of coming back empty. Keep the record write off the per-event path: only a changed session
file (or a session with no file yet, which clears the record) is written.

Tests: `npx vitest run .pi/test/tern/startup-session.test.ts .pi/test/tern/commands.test.ts
.pi/test/tern/dock.test.ts` and `node --experimental-strip-types tools/e2e/tern-durable-resume.mjs` (real
SDK + real bridge; needs `PI_EXECUTABLE` pointing at an npm-installed Pi when the host Pi is a managed
standalone build).

### Composer input and native editing

The runner's hello advertises `edit`, `undo` and `send` (`PI_TSP_FEATURES` in `.pi/lib/tern/tsp.ts`, the same
set OMP sends), so Tern owns clicks, drags, double/triple clicks and ⌘A/Ctrl+A in **every** `editor`/`input`
node Pi draws: the composer and an extension prompt's field (`ui-prompt-input`). Each such field must handle
`edit` (drop it when `len` differs from its text: keys were in flight), `undo` and draw a selection with
`anchor` (there is no `selection` prop). Text state is `DraftEditor` (`.pi/lib/tern/draft-edit.ts`;
`spliceHostEdit` is the shared edit apply); a new natively edited field must use it too, or a selection
replaced by typing is lost. `send` goes through `submit` only while the composer reports `sendable`.

Keys: `.pi/lib/tern/keys.ts` maps pi-tui's editor bindings plus the PC chords Tern leaves to the program
(Ctrl+←/→, Home/End, Ctrl+Home/End, Delete, Ctrl+Delete, Ctrl+Backspace = BS 0x08, Ctrl+U/K); kitty key
releases are ignored. Trebol's own `ctrl+b` maps to the `detach` effect, which `run.ts` sends to
`PiTernBridge.backgroundForegroundWork()`; it and Pi's editor both call `.pi/lib/ui/running-work.ts`'s
`detachRunningWork`, the one order for moving the work blocking a turn (Bash, then `wait_for_agent` /
`multi_agent_wait`, then a foreground `Subagent`) to the background card. Tern alone also draws that chord as
a **Background** button in the composer bar (`composer-view.ts` `backgroundable`, action `bg.background`):
it is a projection of state — shown only while a foreground item is live *and* `hasRunningWorkDetach()`
reports a published writer — and it calls the same `backgroundForegroundWork()`, so key and button cannot
drift. `PiTernBridge.applyEditKey` is the
one dispatch for caret/delete/undo keys, used by `run.ts` and the e2e drivers. Windows: Tern writes
terminal → program messages as OSC 877 (ST or BEL) through ConPTY and `splitInput` accepts both framings;
`run.ts` enables VT input on win32. Ctrl+V reads go through
`.pi/lib/tern/clipboard.ts` (pi-tui native, else wl-paste / xclip / xsel / PowerShell / pbpaste).

Two extension shortcuts shadow a built-in, so `~/.pi/agent/keybindings.json` releases the built-in alias:
`tui.editor.cursorLeft` keeps only `left` (ctrl+b belongs to `detach`) and `app.session.toggleNamedFilter`
moves to `ctrl+alt+n` (ctrl+n belongs to `trebol-toggle`; the picker hint follows the binding). A conflict is
only reported, never resolved automatically, so a fresh machine without those two entries warns at startup.

Attachments (`.pi/lib/tern/attachments.ts`): copied files, a copied image (saved to a temp file), and files
dropped on the pane become chips above the editor (`omp.composer.chips`), any mix at once, up to 20. The runner
enables bracketed paste (`?2004h`, reset on exit) so Tern delivers a drop as one paste of shell-escaped
absolute paths; `parseDroppedPaths` attaches a paste only when every token is an existing absolute path (also
quoted, `file://`, `~/`, Windows backslash paths), so ordinary text stays text. Image chips draw a blob (sent
before the frame, id = SHA-256) at its pixel size within 12ch × 4lines. Remove one with its × or the chip's
`remove-attachment` menu action; ⌫ on an empty draft takes back the last; Ctrl+C clears all. A submit sends images
as Pi `images` (`session.prompt(text, { images })`; a model whose `input` lacks `image` gets paths instead) and
other files as an `Attached files:` path list; attachments alone are a valid submit; queued follow-ups carry them.

Diagnose input with `PI_TERN_INPUT_LOG=<file>` (raw keys and TSP events per read). Tests:
`npx vitest run .pi/test/tern/native-edit.test.ts .pi/test/tern/platform-input.test.ts
.pi/test/tern/clipboard.test.ts .pi/test/tern/attachments.test.ts` (the hello test runs the real runner on a pty via
`.pi/test/tern/fixtures/pty-hello.py`) and `node --experimental-strip-types tools/e2e/tern-draft-editing.mjs`.
Live: `tern serve --control <sock>` then `tern ctl --control <sock>` `run`, `click`, `dblclick`,
`down`/`move`/`up`, `key`, `type "…"`, `drop .sf-editor file A file B`, `shot <name>` and `tree .sf-editor`
(a `selecting` class means a drawn selection).

## Validation

```sh
npm install                       # one workspace install; single lockfile
npm run build                     # tsc for every package, dependency order
npm test                          # vitest: packages/**/test, .pi/test, tests/
npx vitest run .pi/test/context   # one layer, or any path/file
npm run build -w @pi-swarm/prompt # one package
npm run build:experimental        # runtime + packages/experimental/absurd-worker (not in `build`)
npm run test:integration          # refuses with exit 2 until a live Postgres/Absurd suite exists
npm run doctor                    # global-install health: PATH, dist, deps, models.json, theme
node tools/repo/rewrite-imports.mjs --check   # every relative specifier resolves
npm run check:symlinks            # no tracked symlink escapes this checkout
npm run dogfood                   # build + test
```

### Sharing dependencies across worktrees

Each checkout installs its own `node_modules` (`npm ci`). To reuse one install
across local worktrees, link it explicitly and relatively — never commit a link:

```sh
node tools/repo/link-node-modules.mjs ../trebol   # this worktree -> ../trebol/node_modules
npm run check:symlinks                            # proves the link is untracked
```

The helper refuses an already-real directory and never creates an absolute
link. `npm ci` writes into the shared directory, so a per-worktree install is
still the right default whenever `package-lock.json` differs between branches.

### Installing globally

The repository is itself a Pi package (root `package.json` `pi` manifest:
individual extension entrypoints and `.pi/themes`). Never copy `extensions/`
anywhere — the extensions import `.pi/lib` and `packages/*/src` by relative
path (tests import `tests/fixtures`) and need the hoisted `node_modules`.

```sh
# dev box: link this checkout (no copy; dedupes against .pi/ by absolute path)
pi install /home/swarm/Work/Pi-Swarm
# any other machine (pin a tag or commit; `pi update` reconciles the ref)
pi install git:github.com/cloverinternational/trebol@<tag>
# from the installed checkout: PATH, versions, dist, deps, models.json, theme, packages[]
npm run doctor
```

What `pi install` does (vendor/pi-mono `package-manager.ts`): `git clone`
(no submodules) into `~/.pi/agent/git/<host>/<path>`, then
`npm install --omit=dev`, never `npm run build`. Consequences that are
contracts here:

- the root `prepare` script is the only build a global install gets; every
  package consumed from `dist/` at runtime (`@pi-swarm/core`,
  `@pi-swarm/runtime-contracts`) must be in `build:runtime`;
- anything imported at runtime is in root or package `dependencies`, never
  `devDependencies`;
- nothing under `vendor/` is imported at runtime (submodules are empty in a
  package clone); `ask_user_question` is the in-tree fork for that reason;
- on a machine that also opens this repo as a project, use the local-path
  form — a `git:` install has a different absolute path and would register
  every tool twice.

Prove a change against the package path, not just the project boot.
Host-level items (node on the
non-interactive `PATH`, `models.json` `maxTokens`, tmux launch shell,
provider key scope) are outside the package; `npm run doctor` reports the
first two.

Run the narrowest relevant check first, then broader checks when the change is
cross-package. Never claim a check passed unless it was actually run. After
moving files, run the import rewriter with a move map and then `--check`
rather than editing specifiers by hand.

## Safety and vendor policy

- Preserve uncommitted user changes. Never reset, clean, or rewrite unrelated
  files.
- Do not expose credentials, API keys, session transcripts, generated state,
  or large dependency trees in source changes or output. Treat `.pi/config` as
  sensitive; use the credential vault for provided secrets.
- Do not edit, format, regenerate, delete, move, or otherwise mutate anything
  under `vendor/` (formerly `upstream/`). Read it for reference and implement
  local changes in packages, extensions, tools, or docs. If a vendored change
  appears necessary, stop and ask for explicit approval.

### Compact TaskManage completion questions

Tasks may carry 1–12 `questions: [{id,text}]` (IDs ≤64, text ≤240).
Complete them with `answers: [{question,answer,evidence}]` in the same update;
answers are ≤240 characters, evidence references ≤512. Use workspace-local
`file.md#heading` or `file#Lx-Ly` references for detailed proof. Missing answers,
unknown IDs and unavailable evidence reject completion. Reference availability
is not semantic verification. Legacy questionless tasks remain compatible. No
separate question lifecycle or follow-up tool-call limit is introduced.

`create` operation keys are idempotency keys (#298). A replayed key succeeds
only when the request is identical: each task stores `createFingerprint`, a
SHA-256 of its create op. A different payload fails with non-retryable
`idempotency_conflict` naming the existing task. Tasks persisted before the
fingerprint fall back to comparing subject and questions. Update keys stay
reusable per-call aliases. E2E: `node tools/e2e/taskmanage-create-key-conflict.mjs`.

## Jev first-finder knowledge audit (opt-in)

`/jev-audit on|off|status|now` controls the session audit; environment
`PI_SWARM_JEV_AUDIT=on` enables it initially. `TYPESAFE_API_KEY` is resolved from the environment first, then the exact vault
credential `typesafe-api-key` through the existing internal resolver (never tool
parameters). `PI_SWARM_JEV_CREDENTIAL_ID` overrides the ID;
`PI_SWARM_JEV_VAULT=off` disables fallback. Values are never put in audit evidence. The state-layer adapter
`extensions/jev-knowledge-audit/extension.ts` counts completed Pi turns and
audits at the next turn start after five new turns, and on agent_end for final evidence. Stop audits process one bounded batch and never wake the agent; remaining backlog is retained. Domain collection/API/review
logic is in `.pi/lib/context/jev-knowledge-audit.ts`; mode coordination lives in
`jev-audit-mode.ts`. Persisted `pi-swarm-jev-audit` entries hold cursor/count and
bounded redacted pending review; `pi-swarm-jev-review` context messages are
untrusted proposals, injected once without a wake-up turn.

Jev is the first classifier, not a generator or verifier. At most three bounded
new excerpts per audit are routed as memory, procedure, mixed, temporary, unresolved,
or noise. Backlog remains for later audits. Main agent review and existing
revision-checked memory_history/SkillManage tools own all actual writes. Skills
are audited only when their visible invocation/view output is encountered; no
whole-library automatic scan or rewrite. Mandatory instructions are not removed.

Existing generative knowledge-enrichment capture defers while Jev is enabled;
off preserves its old behavior. A three-second deadline, session cancellation,
child suppression, exact citations and bounded request/response protect the loop.
API failure keeps evidence retryable and never blocks ordinary work. Missing
compacted cursors pause audit rather than guessing. `/jev-audit now` queues review
for the next model context; it does not start a new turn. Reload/new session is
required to load newly installed extension code.

Focused validation: `npx vitest run .pi/test/context/jev-knowledge-audit.test.ts
.pi/test/state/jev-knowledge-audit.test.ts .pi/test/state/knowledge-enrichment.test.ts`.
Live API test is opt-in: `PI_SWARM_JEV_LIVE_TEST=1 npx vitest run
.pi/test/context/jev-live.test.ts` with the key in the environment.

## Budgeted Jev-triggered memory maintenance

Enable `/jev-audit on` then `/memory-worker on`. `/memory-worker off|status`
controls the parent-session queue. Defaults: one worker at a time, up to four
queued Jev packets, six new child model turns, 90-second wall deadline. The main
agent remains free to work. No Harbor or global memory/skill edits are involved.

`extensions/memory-maintenance/extension.ts` owns queue/cancellation/receipts;
`.pi/lib/context/memory-maintenance-runner.ts` snapshots the active visible branch
and invokes actual Pi `--fork` into a separate child session. Snapshots are
redacted, omit reasoning, preserve source IDs, are capped at 2MB, and remain under
ignored `.pi/agent-sessions/` for evidence links. No parent branch switch occurs.
The child loads only `.pi/lib/state/memory-maintenance-worker.ts`, with no normal
extensions/tools. Its allowlist is `memory_evidence` and restricted `memory_history`.

The worker must search first, read cited snapshot evidence before verified writes,
and use expectedRevision for corrections. Repository/worktree only; global/session
writes, deletion, nested agents, shell, code edits and SkillManage are unavailable.
Verified status is attributed agent judgment, not proof from Jev. Procedure findings
remain unresolved skill proposals rather than autonomous skill edits. Cancellation
revokes a write lease and terminates the subprocess; completed prior writes remain
valid history. Interrupted/failed runs may contain partial writes: inspect before
retrying. A filesystem lease check is not a cross-process transactional barrier.

`.pi/lib/context/memory-query-budget.ts` tracks successful repository/worktree
`memory_history` search/get/replay calls by ID and result. Successful empty lookup
counts; failures, writes and other scopes/tools do not. After ten completed main
turns without lookup, one soft reminder is injected. It rearms on successful lookup
or a new interactive/RPC input; it never blocks tools or starts a new turn.

Worker completion is a bounded operation receipt at the next natural context
boundary, not an unsolicited continuation. Jev packets are reviewed by the worker
when enabled, otherwise by the main agent. Session replacement cancels stale work.
Reload may restart an interrupted queued item; store dedup/CAS limit repeated writes.

Validation: focused `memory-maintenance*` and `memory-query-budget` Vitest tests;
`node tools/experiments/jev-audit/memory-worker-smoke.mjs` exercises real installed
Pi fork/evidence/write/query against a local scripted provider and isolated store.
It does not establish unscripted reviewer accuracy or quality improvements.

### Staged historical review mapping

`tools/experiments/jev-backfill/project_mapping.py` uses the existing Git-common-dir
repository/worktree identity; missing workspaces remain unresolved. Explicit alias
files are reviewable mapping evidence, never guessed from names. `review_staged.py`
uses the restricted memory worker with an explicit staging store, fixed six-turn/
90-second limits, and durable max-ten-job reservation ledger. No live promotion.
Memory maintenance uses namespace `default` only so recall can discover results;
project isolation is provided by repository/worktree identity, not model-invented
namespaces. See `docs/reference/jev-backfill-project-review.md` for references,
current pilot counts, provenance, and unresolved coverage limits.

### Operational supervisor (initial opt-in slice)

`/jev-supervisor on|off|status` adds bounded work-freshness and review-need questions
to Jev's existing call. Findings go to the independent memory worker when enabled.
Worker tools now additionally expose `supervisor_review` (confirm/reject/insufficient
with read evidence) and `supervisor_task_proposal` (proposal only). Parent-owned
reconciliation in `.pi/lib/context/supervisor-task-reconcile.ts` requires
`PI_SWARM_SUPERVISOR_TASK_APPLY=on`, current snapshot validation, active TaskManage,
and existing policy hooks. No completion/deletion or vault permission changes.

Jev and maintenance adapters share mode/dispatch by exact session identity, not
ExtensionAPI object identity. Autogen writes a fresh state entry on session_compact;
this does not reset budgets. Full live compaction/reviewer reconciliation still
needs dogfood. Skill cleanup remains an isolated preview, not a global migration.
See `docs/architecture/jev-operational-supervisor.md` for explicit unfinished seams.

Credential references for memory are projected by
`.pi/lib/context/vault-memory-evidence.ts` only from explicit vault-list results.
Only ID, purpose/name, scope and kind are eligible; get/add/exec values and opaque
message details are excluded from Jev evidence and maintenance snapshots. A listed
credential is not proof of project usage or execution authorization. No new vault
permissions or autonomous credential inventory scans are introduced.

Maintenance review policy is loaded from
`.pi/lib/context/prompts/memory-review-policy.md` (adapted evidence-prefix review
from Dream-RSI Appendix B.2, not a replay simulator). The runner records its hash.
Unscripted dogfood entry: `tools/experiments/jev-audit/dogfood-integrated.mjs`, using
configured provider authentication and isolated fixture/memory/skill state.
A headless parent can finish before maintenance completion is reconciled; persisted
`running` alone is not proof of live work. Inspect actual receipts/store on recovery.

## Unified Supervisor surface (supersedes earlier slash-command instructions)

Use only `/supervisor` for Jev audit, operational review and memory-worker controls.
`/jev-audit`, `/jev-supervisor`, `/memory-worker` registrations are removed, not aliases.
`/supervisor status` reports sanitized settings and adapter status. The compact
setWidget projection does not replace the single metrics-owned footer.

UI adapter: `extensions/supervisor/extension.ts`; shared session control:
`.pi/lib/context/supervisor-control.ts`; validated settings: `supervisor-settings.ts`.
Global defaults: `~/.swarm/config/supervisor.json`. Per-project overrides:
Git-common-dir `pi-swarm/supervisor.json`, or non-Git `.swarm/supervisor.json`.
Explicit project false overrides global true. No secret values accepted in settings.

Jev credential auto resolution: configured TypeSafe provider via Pi model registry,
then named environment variable, then named vault credential. Explicit provider/env/
vault modes do not fall back to other sources. Default references: `typesafe`,
`TYPESAFE_API_KEY`, `typesafe-api-key`. Endpoint remains fixed TypeSafe HTTPS.
Reviewer inherits current session model or configured provider/model override.

Panel changes apply to loaded audit/worker adapters. Pause cancels active work and
clears pending proposals. Worker caps remain at most6turns/90s; cadence1–50turns.
Connection test is explicit paid bounded call; credential presence is not health.
Skill mutation remains preview-only in this panel; no fake enable switch.
Existing session enabled entries no longer override persisted settings. Legacy
PI_SWARM_JEV_AUDIT=on boot flag applies only when no global/project master setting
exists. New code needs reload. Tests: supervisor-settings, jev-credential, UI
supervisor, and audit/maintenance lifecycle suites.

### Task enforcement correction

The canonical TaskManage hook pipeline now defaults to `block`, not `off`:
acting tools require a focused in-progress task; TaskManage, planning, interaction,
skill and read-only recovery paths remain available. The secondary coordinator
stays silent to avoid duplicate hooks. Explicit hook-off policy remains honored.
`node tools/experiments/jev-audit/task-enforcement-smoke.mjs` proves actual Pi
blocked write -> TaskManage create -> successful write in a temporary workspace.
`memory_history` `search`/`get` are exempt from this gate (`isReadOnlyMemoryCall`
in `.pi/lib/runtime/swarm-toolclass.ts`); its write operations stay gated. Per-turn
hooks are dormant for the first 5 turns (`HOOK_WARMUP_TURNS`), except composition
hooks registered with `{ warmup: false }` (swarm-prompt, so the selected prompt reaches the first
request; e2e `node tools/e2e/forge-prompt-first-turn.mjs`), so gate smokes
must pad warm-up turns: `node tools/e2e/memory-gate.mjs` does, while the
task-enforcement smoke above does not and currently passes its first write.
Session boundary events (`session_start`, `session_switch`,
`session_before_compact`, `session_shutdown`, `shutdown`) are never warm-up
gated: each happens once, and `session_start` happens while the turn count is
still 0, so a turn-count gate would leave it permanently unreachable.
Reviewed, citable project facts promoted from memory candidates live in
`docs/reference/project-findings.md` under stable `F-NNNN` headings.

Supervisor operational-review settings now also control reviewed parent task
application; the hidden PI_SWARM_SUPERVISOR_TASK_APPLY flag is no longer required.
Independent confirmation, live snapshot checks and owning TaskManage hooks remain
mandatory. Project `enabled:false` still disables audit/worker, not the normal
task-enforcement hooks. Reload is required for already-running sessions.

### Durable skill-budget enforcement

Autogen `gateTool` enforcement no longer depends on `modelContext`: disabling
manager-generated prose in the Pi adapter does not disable execution gating.
In auto mode, after task focus, the durable manager charges non-exempt calls
(including Bash), blocks the next call at5 onboarding/90 working calls, and
resets through actual successful Skill invocation. SkillManage list/view alone
cannot refill this budget. Recovery/task/interaction/read tools remain exempt.
The built-in skill-budget hook now reads the durable manager's gate and status,
so its model-visible block names `Skill` and explains that `SkillManage` create,
patch, view, or review does not refill: create if appropriate, then invoke.
Read-only Bash still counts, while a blocked call is not charged. The builtin
lifecycle skill-review reminder remains separate from the execution budget;
explicit autogen manual/off modes remain distinct.
Verify real host: `node tools/experiments/jev-audit/skill-budget-smoke.mjs`.

### Human handoff on unfinished stop

ask_user_question uses the ask-user questionnaire schema and explicit submit/cancel
flow. The old timeout argument and dialog fallback are not part of this schema.
Run `npm run test:ask-user` for the extension-local Node test suite.

After observed work and a normal stop, taskmanage's canonical turn_end hook now
considers unowned pending/in-progress tasks (including blocked tasks), reconciles
actual progress, and instructs one ask_user_question call about remaining work.
A prose question alone does not replace the tool. The once-per-external-request
allowance, abort/error/user-interaction/background-work/shutdown and plan/child
suppression remain. No auto-completion, deletion, or infinite continuation.
Headless unavailable interaction must be reported with pending tasks retained.

### Machine-local runtime state

Runtime bookkeeping never lives in the workspace. `.pi/lib/state/workspace-state.ts`
resolves `$PI_SWARM_STATE_DIR`, else `$XDG_STATE_HOME/pi-swarm`, else
`~/.local/state/pi-swarm`, and keys one folder per workspace by
`<basename>-<sha256(absolute path)[0:12]>`, so two checkouts with the same name never
share state. Claw (`ClawStore.forWorkspace` → `<root>/workspaces/<key>/claw`), the
scheduler (`extensions/schedule`, `<root>/workspaces/<key>/scheduled_tasks.json`) and
the diagnostics log all use it. A legacy `<workspace>/.swarm/claw` directory or
`.swarm/scheduled_tasks.json` is adopted once (rename, staged copy across devices) and
never merged into an existing state folder; the legacy copy is left for inspection on
a conflict.

`.swarm/` inside a project stays reserved for user-authored inputs (`AGENTS.md`,
skills, hook config). Do not add a blanket `.swarm/` ignore and do not write runtime
files there: Claw's `control.json`, `supervisor.json` and `sessions/*.json` used to
appear as untracked files in every user's `git status` exactly that way. Evidence:
`.pi/test/state/workspace-state.test.ts`, `.pi/test/claw/state-dir.test.ts`,
`.pi/test/tools/schedule-state.test.ts`, plus an observed run where
`git status --porcelain` stays empty. Suites isolate themselves through
`tests/setup/isolate-state.ts`; never point one at the real state directory.

### Temporary runtime review logs
These are opt-in (`PI_SWARM_DIAGNOSTICS=1`) and are never written inside a working
tree. `.pi/lib/context/execution-log.ts` (`executionLog`) writes bounded metadata to
`$PI_SWARM_DIAGNOSTICS_DIR`, else `$XDG_STATE_HOME/pi-swarm/diagnostics`, else
`~/.local/state/pi-swarm/diagnostics`, under one `<basename>-<path-hash>/<area>/`
folder per workspace. It used to create `./.swarmpi/<area>/` in whatever repository
Pi ran in — one untracked file per captured memory candidate, invisible in this
repository only because its `.gitignore` lists `.swarmpi/`, and litter in every
user's `git status`. Keep the write out of the worktree, and keep the default off:
diagnostics are harness support, not project output. Jev and lifecycle memory capture
record attempt/outcome counts and candidate-save receipts, not raw evidence or
credentials. Best-effort writes must never break execution. Seven-day retention on
next write, 500 files/category, 32KiB/file, mode 0700/0600. Safe to delete; logs are
not memory and do not backfill earlier runs. Reload required for instrumentation.

### Memory capture quality, first curation batch
Lifecycle capture supplies project identity and a bounded sample of existing
records to discourage semantic duplicates. Its prompt excludes transient execution
history and asks for explicit project ownership. These are model guidance, not a
semantic enforcement guarantee. Saved candidates emit metadata receipts under
the diagnostics directory above (only when enabled). Restricted reviewer policy
uses the same durability filter.
First code-reviewed worktree records document verified-only recall and the exact
supervisor configuration location; tools/experiments/memory-curation/save-reviewed.ts
writes them through the canonical store and checks production recall. This does not
bulk-clean existing candidates, enable supervisor, or certify unrelated records.

## Installed MCP adapter ownership

Pi's built-in MCP extension (`builtin:mcp`, registers `/mcp`) is the MCP stack. It reads
`~/.pi/agent/mcp.json` and the trusted project's `.pi/mcp.json`, owns connections, OAuth sign-in,
exposure and the `/mcp` manager, and registers tools as `mcp__<server>__<tool>`. The Tern runner
(`.pi/lib/tern/run.ts`) must pass Pi's `builtInExtensions` as `extensionFactories` the way Pi's CLI
does (`.pi/lib/tern/pi-builtins.ts` reads the installed list); without them a pane has no `/mcp`,
codemode or tool_search. That module also observes the MCP extension's `registerTool` calls and
publishes servers with reachable tools to `.pi/lib/tools/mcp-status.ts`, which the startup card
reads. `extensions/mcp-fallback` stands down (no discovery, `/swarm-mcp` points to `/mcp`) whenever
`/mcp` or `/pi-mcp` is registered; it only connects in hosts that load neither.

Adding servers never bypasses Pi. `/mcp-add` (registered by `extensions/mcp-fallback`, logic in
`.pi/lib/tools/mcp-add.ts`) turns a pasted README snippet (`{"mcpServers": …}`, VS Code `{"servers": …}`, a
bare map or a `"name": {…}` fragment), a URL, or `pi mcp add` arguments into Pi's own `runMcpCommand(["add",
…])` (loaded through `.pi/lib/tools/pi-dist.ts`), which validates and writes `mcp.json`; then it reloads so
Pi's MCP connects the server. Literal secrets in headers/env need confirmation (prefer `${VAR}`/`!command`).
The Tern plugin `tern-plugins/mcp` (`tern plugin link tern-plugins/mcp`) adds palette commands **Add MCP
server** / **MCP servers** and an `mcp.servers` block outside Pi's TUI: it lists with `pi mcp list --json`,
adds with `pi mcp add`, signs in with `pi mcp login`, removes with `pi mcp remove` (argv, no shell), and
mirrors the same converter in Luau. Running Pi sessions see plugin-added servers after `/reload`. Tests:
`.pi/test/tools/mcp-add.test.ts`; the plugin's runtime behaviour has no automated test (offscreen
`tern shot` does not load plugins).

When `pi-mcp-adapter` is installed (its `/pi-mcp` command is present), it owns
`/mcp`, MCP connection negotiation, resources, and prompts. Pi-Swarm skips its
fallback startup discovery; the fallback diagnostic command is `/swarm-mcp`.
Pi-Swarm's surface filter preserves already-selected registered MCP tools,
including adapter definitions labelled `MCP:`, but does not reactivate tools
excluded by the user's selection. Adapter configs use literal `headers` (or
its explicit credential-reference syntax), not Pi-Swarm's custom `apiKey` fields.
Never print header values during diagnostics. Vendor example configs are not
runtime configuration sources.

### Install recovery diagnostics

`tools/install/doctor.mjs` checks runtime dependencies including `re2-wasm`
and all three prepare-built runtime packages. Its package-source helper
(`tools/install/package-sources.mjs`) resolves local settings paths and flags
historical Trebol/Swarm Git installs alongside a development checkout. A Git
clone is not the same resource identity as the local checkout: keep only one
registration to avoid duplicate tools. Run `npm install` in a fresh checkout
before opening Pi; local package registration alone does not prove dependencies
or dist outputs exist. Regression tests: `tests/install-package-sources.test.ts`.

Installation layout is documented in `docs/reference/install-layout.md`.
`npm run check:install` uses `tools/install/check-load.mjs` to load the package
with isolated temporary settings, without starting a session or invoking a model.
`tools/install/pi-host.mjs` resolves the SDK belonging to the PATH executable
(or `PI_EXECUTABLE`); the toggle session probe shares this resolver. No hardcoded
global npm prefix. This executes extension factories, not a security sandbox;
it does not certify individual tools or real-user resource filters.

Pi itself compares package sources by lexical path, so a linked worktree of this
repository (`.pi/settings.json` registers `packages: [".."]`) plus a configured
registration of the main checkout loads every extension twice and Pi exits on the
duplicate tool registrations. Claw resolves this before it opens a worker tab:
`.pi/lib/claw/launch-plan.ts` identifies a repository by its git common dir (or
realpath outside git), keeps the checkout the worker runs in, and launches that
worker with an explicit `-ne -e ...` extension plan. Distinct repositories are
untouched; a conflict between two different repositories is reported as a failed
run with the worker's captured stderr line instead of "lost".
Regression tests: `.pi/test/claw/launch-plan.test.ts`, `.pi/test/claw/worker-launch.test.ts`.

### Flat extension migration (worktree)

Public entrypoints are `extensions/<name>/index.ts`; implementations and private
assets live beside them. Root manifest ordering is explicit for compatibility,
not a dependency injection mechanism. `control-task-tools` owns its daemon
client and registrations; `mcp-fallback` owns fallback MCP and the legacy
`/swarm-runtime` diagnostic; `swarm-agent-tools` owns both Agent/AgentControl and
legacy agent tools with one manager. Only `swarm-prompt` registers prompt hooks.
Only `vault` registers the vault tool; history does not silently enable it.
No legacy layer manifests remain. Existing user resource filters require the
path migration in `tools/repo/extension-moves.json`; personal settings are not
automatically rewritten. Shared `.pi/lib/runtime` helpers remain and are not
claimed to be eliminated by this migration.

Installation verification supports `npm run check:install -- --extension
extensions/<name>/index.ts` for isolated entry loading. The preview-only settings
migration command is `node tools/install/migrate-extension-paths.mjs
<settings.json>`; it never writes configuration and flags legacy glob filters for
manual review. See the independent-extensions architecture record for latest
verification and unresolved macOS shell / task-correction smoke failures.

Headless task correction uses the normal Pi tool_call rejection/result path;
stream-time speculative abort is TUI-only. Validation:
`.pi/test/runtime/hook-correction-headless.test.ts` and
`node tools/experiments/jev-audit/task-enforcement-smoke.mjs` (isolated local
scripted provider; requires no provider credentials).

Native settlement now owns final notification: `.pi/lib/runtime/agent-settled.ts`
retains the last attempt payload but schedules no timers. Do not reintroduce a
quiet-period completion heuristic. Lifecycle supervisor dispatch of TaskManage
(`.pi/lib/runtime/session-handoff.ts`) prefers ctx.executeTool and retains the
registered-definition compatibility path explicitly.
macOS background-shell streaming uses `.pi/lib/tools/pty-runner.py` with optional
Python3 and a stdbuf/direct fallback; Linux uses util-linux script. Test the real
shell suite after any runner change. Local complete-suite validation on macOS
uses canonical TMPDIR=/private/tmp to avoid /var symlink-path fixture failures.

Auto and goal continuation use `agent_before_settle` drafts + continue:true;
final settlement is observational. Preserve existing boundary drafts and do not
require pre-draft canContinue: adding a custom message establishes valid context.
Real-host check: `node tools/e2e/auto-boundary.mjs` (loopback scripted provider,
isolated settings, no paid API). Scheduler timers still use session wakeup.

Correction now uses authoritative tool_call rejection in every mode; speculative
streaming abort previews and settled wakeups are removed. Session handoff
compatibility registrations are session-scoped and disposed on shutdown; native
tool-context calls use Pi executeTool. Supervisor's non-tool-context fallback
still sees only Trebol-registered hooks and remains explicit compatibility debt.

Fallback hook dispatch is session-scoped, preserves multiple handlers per group,
and removes owner registrations on shutdown. It rejects missing session identity.
Ctrl+N adapter installation returns a release lease; last owner restores its
patch, without clobbering later adapters. Tests: session-hook-dispatch and
 trebol-shortcut under `.pi/test/runtime/`, plus actual-host toggle smoke.

PR 136 review dispositions and validation are recorded in
`docs/architecture/pr-136-review.md`, including intentionally fail-closed session
identity and preserved host-adapter constraints. Install source parsing shares
one Git identity parser with doctor; migration preview covers top-level extension
paths as well as package filters. Host lookup supports Windows npm shim layout
with suffix tests; live Windows verification remains separate.

### Tern MCP connection list

The startup card (`.pi/lib/tern/startup-card.ts`) shows MCP status below Recent
commits. `extensions/mcp-fallback/extension.ts` publishes session-ID-scoped,
name-only snapshots through `.pi/lib/tools/mcp-status.ts`; the Tern bridge
subscribes and reads only its current session. No configuration/tool-name
inference is used. `MCPManager.connectedServers()` means initialize and tool
listing succeeded with no subsequent observed disconnect. Stdio exit/error and
observed HTTP transport failure invalidate the entry; HTTP is last-observed
readiness, not a continuously probed health guarantee. No background health
requests are added. Adapter-owned/unobservable state is unavailable, not empty.
Session replacement/shutdown clear ownership and bridge close unsubscribes.
Tests: `.pi/test/tern/{startup-card-mcp,mcp-bridge}.test.ts`,
`.pi/test/tools/{mcp-status,mcp-fallback-status}.test.ts`, and
`packages/tools/mcp/test/index.test.ts`.

### MCP exposure to the model and to `/mcp`

Two separate facts decide whether the agent can use MCP: what Pi registers, and
what this harness leaves active. Pi's builtin MCP extension registers
`mcp__<server>__<tool>` and tags each definition with an `exposure` —
`direct` (declared like a builtin), `deferred` (declared only after
`tool_search` loads it), `codemode`, or `hidden`. Measured on Pi 1.3.0 with a
live probe: the project server registered `direct` tools that reached the
model, while four user-scope servers registered `deferred` tools that did not,
because `tool_search` was never in the active set — `codemode` was whitelisted
in `swarmSurfaceFor` and `tool_search` was not, and servers connecting in the
background register their tools after the last alignment pass.

Rules that keep this true:

- `swarmSurfaceFor` treats `codemode` and `tool_search` alike; gating one hides
  every server whose exposure asks for it.
- `alignTools` (`.pi/lib/runtime/swarm-transport-parity.ts` caller, in
  `extensions/swarm-transport-parity/extension.ts`) activates `tool_search`
  whenever a registered `mcp__*` definition is `deferred`, and re-runs at
  `turn_start` so late registrations are picked up.
- The same pass publishes `.pi/lib/tools/mcp-inventory.ts` (session-scoped:
  server, exposure, active/total, tool names). Tern's `/mcp` reads Pi's live
  `getAllTools()` / `getActiveToolNames()` at invocation and while visible,
  rendering unavailable metadata honestly on older hosts, through
  `.pi/lib/tern/mcp-panel.ts`. This includes background registrations before any
  model turn; an empty registry does not prove no servers are configured.
  Pi's own bare `/mcp` opens a TUI component this
  frontend cannot draw, so the bridge answers bare `/mcp` itself and leaves
  `login`/`logout`/`reconnect` on Pi's handler.
- `extensions/swarm-prompt/extension.ts` replaces Pi's base prompt; it must
  carry forward any string in `systemPromptOptions.sections` (the MCP
  extension's `mcp_servers`) rather than dropping the map.

Tests: `.pi/test/runtime/{swarm-mcp-activation,swarm-extra-tool-gating}.test.ts`,
`.pi/test/tools/mcp-inventory.test.ts`, `.pi/test/tern/mcp-command.test.ts`.

### Native Tern MCP control center

Bare `/mcp` and the startup MCP line open a native TSP overlay, not transcript
text. `mcp-panel.ts` renders Servers / Tools / Diagnostics, responsive master/detail
tables, searchable schemas and guided configuration forms. `mcp-controller.ts`
owns editing, confirmation, single-flight actions and visible-only registry
refresh (no network probes). Closing drops form text and its undo history;
session replacement invalidates pending UI completions.

`pi-builtins.ts` captures the builtin MCP command handler and publishes a
session-owned `mcp-host.ts` adapter. It loads configuration through Pi's own
`loadMcpConfig`, using the session's actual project trust, and merges extension
registrations by Pi namespace. Reconnect/auth reuse Pi's handler; an RPC-shaped
UI context avoids its terminal-only custom manager while retaining Tern native
input for OAuth redirects. Add/Remove call Pi's CLI implementation, never a
custom config writer; their output is not forwarded because it may contain
credentials. Scope/overwrite/plaintext-secret warnings precede writes. Reload
is explicit. The adapter does not call `pi mcp list`, which opens duplicate
connections. Connection health is unknown beyond observed tool registrations.

Tests: `.pi/test/tern/{mcp-host,mcp-control-center,mcp-command,pi-builtins}.test.ts`.
The existing `mcp-panel.test.ts` separately covers the terminal-component adapter.
Native screenshot harness: `node tools/e2e/tern-mcp-panel.mjs` (deterministic
fixtures, no real connections or configuration mutations), artifacts under
`artifacts/tern-mcp/`. Real OAuth/browser completion is not certified by that
harness. Restart the pane for runner JavaScript changes; `/reload` alone does
not replace the bridge implementation.

### Startup card watcher budget

`watchRepo()` in the same module must never recurse over the whole worktree or
the git directory: `fs.watch(..., { recursive: true })` costs one inotify watch
per directory there (thousands in a JavaScript checkout, almost all
`node_modules` and `.git`), and `fs.inotify.max_user_watches` is shared by the
whole session. Recursion is limited to the top-level worktree entries, with the
root and the git directory watched without it. Every watcher is created through
`watchSafely()`, which owns the asynchronous `'error'` event — a `try/catch`
around `watch()` cannot see `ENOSPC`, and an unlistened event aborts the
process. A watcher that fails is dropped, and the card keeps its last state.
Tests: `.pi/test/tern/startup-card-watch.test.ts` and the live watcher checks in
`tools/e2e/tern-startup-card.mjs`.

### Startup card mark

The shamrock in the startup card is sized by explicit `w`/`h` on the `image`
node, never by a `lines` bound. `max: { h: "7lines" }` alone let Tern pick a box
wider than the artwork and crop it (`sf-clipped`: 248.84 x 175 measured live),
and a height in text lines grew the mark with the terminal font. The numbers are
**base** pixels: Tern lays the pane out at `font-size/13`, so `w: 36, h: 39`
renders 55.39 x 60 at a 20 px font and keeps the asset's 1172:1268 ratio, which
is what stops the crop. The asset carries a translucent white rim on its path so
the dark brand green reads on a dark theme and blends on a light one. The mark
has no fade-in: a stylesheet animation from `opacity: 0` can be replayed by a
re-render and leave the logo half-drawn, so `STARTUP_CSS` and its `stylesheet`
registration are gone. Tests: `.pi/test/tern/startup-logo.test.ts`.
