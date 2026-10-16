# Tern UI semantic source map (read-only)

Scope: source evidence only. No `.pi/lib/tern` edits. Line numbers are from the files as read.

## 1. Native UI producers

| Owner | Surface | Evidence |
|---|---|---|
| conversation-metrics | `ctx.ui.setFooter` (sole footer slot) | `extensions/conversation-metrics/extension.ts:276` |
| supervisor | `ctx.ui.setWidget("supervisor", ...)` | `extensions/supervisor/extension.ts:11`, cleared at `:15` |
| hooks | `ctx.ui?.setWidget("swarm-hooks", undefined)` | `extensions/hooks/extension.ts:15` |
| taskmanage (task list) | `ui.setWidget("swarm-tasks", ...)` | `packages/tools/taskmanage/src/task-manage.ts:1095-1100`; `refreshWidget` at `:1090` |
| task-browser | `ctx.ui.custom(..., {overlay:true})` | `extensions/task-browser/extension.ts:54`; `openTaskBrowser` at `:53` |
| swarm-btw | `ctx.ui.custom` | `extensions/swarm-btw/extension.ts:104` |
| ask-user | `ctx.ui.custom` | `extensions/ask-user/src/ui/controller.ts:122`, `src/answer-commands.ts:179`, `src/ui/show-settings.ts:14` |
| autogenskills | no setFooter; contributes footer segment | `packages/context/autogenskills/src/index.ts:1220-1232` |

## 2. Footer composition (conversation-metrics)

- Segment registry: `FOOTER_SEGMENTS_KEY` / `footerSegments()` at `extensions/conversation-metrics/extension.ts:25-30`.
- Segment providers: autogen (`packages/context/autogenskills/src/index.ts:1225-1232`), auto-mode (`extensions/swarm-auto/extension.ts:21`), bootstrap-requirement (`extensions/bootstrap/extension.ts:37`), trebol-toggle (`extensions/trebol-toggle/index.ts:5`), swarm-context (`extensions/swarm-context/extension.ts:70`, always returns `undefined`).
- Render: `MetricsFooter.renderRows` at `extensions/conversation-metrics/extension.ts:211-268`.
  - Location/identity/status row: `:234-242`.
  - Context gauge + output/walltime row: `:243-252`.
  - Segment detail rows: `:254-260`.
  - Running-work hint: `:261-262`.
- Update path: `session_start` `:301-319`, `agent_start` `:320-330`, `onAgentSettled` `:331-338`, `message_end` `:339-342`, 500 ms interval `:308-317`, `render()` `:273-278`.
- Source-only helpers: `footerIdentityLine` (`:131-133`) and `footerMetricsLine` (`:135-137`) are used only by `.pi/test/ui/conversation-metrics.test.ts:21-28`, not by `renderRows`.

## 3. Session-backed task state

- Task state is rebuilt from session branch/entries: `packages/tools/taskmanage/src/task-manage.ts:1059`, rehydrate in `bindSession` at `:1100-1105`.
- Events: `session_start` and `session_switch` (`task-manage.ts:1105-1106`).
- Persistence: `pi.appendEntry` via `:1084`; `registerTaskManage` signature at `:1081`.
- Available read APIs on ctx: `sessionManager.getBranch?.()` / `getEntries()`, `ui.setWidget`, `ui.custom`.
- Running-work state (in-process, not session-backed): `.pi/lib/ui/running-work.ts:32-60` (`setRunningWork`, `onRunningWorkChange`, `browsableRunningWork`).

## 4. SDK UI binding and the noOp default

- `noOpUIContext` defines `setWidget`, `setFooter`, `custom`-less no-ops and `confirm: async () => false`, `select: async () => undefined`: `vendor/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:229-242`.
- Runner starts with noOp: `runner.ts:300`. `setUIContext` falls back to noOp: `runner.ts:399-400`. `hasUI()` is `uiContext !== noOpUIContext`: `runner.ts:408`.
- Binding happens only through `session.bindExtensions`: `agent-session.ts:2066-2072`, applied at `:2144-2146`. Callers are interactive (`modes/interactive/interactive-mode.ts:1516`), print (`modes/print-mode.ts:73`), and rpc (`modes/rpc/rpc-mode.ts:318`).
- `createAgentSession` in `vendor/pi-mono/packages/coding-agent/src/core/sdk.ts` does not call `bindExtensions` (grep: no matches). Sessions created this way keep noOp UI.
- Tern caller: `.pi/lib/tern/run.ts:108` calls `createAgentSession({ cwd })` with no UI binding. `.pi/lib/tern` has no `setWidget`, `setFooter`, or `custom` usage (grep).

## 5. Providing UI without fake consent

- Call `session.bindExtensions({ uiContext, mode })` after `createAgentSession`, with a real adapter that forwards to the surface's actual UI (for tern: the bridge's rendering path).
- Keep `confirm`/`select`/`input` wired to the user. Do not return fixed affirmative values. The noOp defaults (`confirm` false, `select` undefined) are the safe fallback, so an unbound session cannot grant consent.
- Widgets/footer through the adapter are display-only and do not need consent.

## 6. Blockers

1. Tern's `createAgentSession` path (`run.ts:108`) never binds UI, so every `setWidget`/`setFooter`/`custom` call in extensions is a silent no-op (`runner.ts:240-241`).
2. No `ExtensionUIContext` adapter exists in `.pi/lib/tern` to forward widgets to the TSP surface.
3. `footerIdentityLine`/`footerMetricsLine` are not on the render path, so changing them alters tests only.
4. Live TUI rendering was not observed; all row claims come from source.

## Files changed

- `docs/reference/tern-ui-semantic-source-map.md` (new).
