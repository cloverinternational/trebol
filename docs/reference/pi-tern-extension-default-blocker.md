# Why a Pi extension alone cannot select TSP at startup

**Update:** A guarded *shell configuration* now routes a bare `pi` typed in an
interactive Tern zsh to the TSP runner without changing Pi core. See
[tern-pi-shell-dispatch.md](tern-pi-shell-dispatch.md). The extension-only
startup limitation below remains true; this is not an extension-only solution.

Checked against this checkout's `@earendil-works/pi-coding-agent` 1.0.4 and
installed `pi` 1.1.0 on 2026-10-11. Both builds retain the CLI mode branch
and start their interactive TUI before extension binding. This documents an **API ownership blocker**,
not a claim that the TSP frontend cannot be implemented.

## Startup and terminal ownership

The installed Pi CLI chooses `runRpcMode(runtime)` or constructs
`new InteractiveMode(runtime, …)` itself in
`node_modules/@earendil-works/pi-coding-agent/dist/main.js:773-789`.
`InteractiveMode` constructs its own renderer in
`dist/modes/interactive/interactive-mode.js:357-382`. Its `init()` calls
`this.ui.start()` **before** initializing extensions at `:653-706`; the
extension binding occurs later at `:1593` (installed 1.1.0: `:1598`). Pi TUI's `start()` calls
`terminal.start(data => this.handleTerminalInput(data), …)` and schedules
rendering (`node_modules/@earendil-works/pi-tui/dist/tui.js:560-569`).

The published `ExtensionAPI` in `dist/core/extensions/types.d.ts:1149-1220`
registers events, commands, tools, and *individual* message/entry renderers.
Its `ExtensionUIContext` permits `onTerminalInput`, editor/header/footer/widget
and custom components (`:65-175`), but has no supported replacement for the
`InteractiveMode` renderer, terminal ownership, or CLI mode selection. Its
`onTerminalInput` subscribes to the already running TUI; using it to launch
another raw-mode TSP input loop would create competing readers/renderers.
`setEditorComponent` replaces one editor component inside that TUI, not the
whole terminal renderer. A `session_start` extension is therefore too late
to select a different frontend for ordinary `pi`.

Minimal reproduction/inspection: launched `/opt/homebrew/bin/pi` in a focused
Tern tab with `tern new tab 'Default' --cwd /Users/swarm/Work/Clover/trebol
--keep-open -- /opt/homebrew/bin/pi` (pane `807453851650`). `tern capture
807453851650 --surfaces` showed Pi's grid header, extension/theme diagnostics,
and `trebol / main … IDLE` footer, **not** the TSP `pi` inline surface. The
test pane was closed with `tern close 807453851650`; other panes were left
untouched. The process used the installed Pi 1.1.0, whose
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js:775-790`
retains the same mode branch and whose `interactive-mode.js:706,1598`
starts TUI before extension binding. Installing a normal extension does not
change that branch. The existing opt-in
`node --experimental-strip-types .pi/lib/tern/run.ts` works because it creates
a *separate Pi SDK session* and is the **only** terminal owner in that process;
it is not an extension inside the ordinary `pi` process. We must not claim
that adding this file to `package.json`'s `pi.extensions` would make it default.

## Safe next change

For `pi` itself to select TSP at startup, Pi must expose a renderer/interactive
mode factory chosen before `this.ui.start()`, or its CLI must select TSP before
constructing `InteractiveMode`. Such a hook can still be *implemented by an
extension package*, but requires a small general Pi core startup API. The
user's constraint here is **extension-only**, so no launcher override, PATH
shim, monkeypatch, or core mutation was made. The existing TSP adapter and
48 focused tests remain intact and opt-in. It is unsafe to dogfood as a
default while extension UI prompts have no native dialogs and the runner uses
Pi's no-op UI context (`confirm` denies, selection/input unavailable).

Rollback: none required for default `pi`; it was not changed. To test the
existing opt-in frontend, run the command above in a Tern pane. To disable
that test, quit its pane; ordinary `pi` remains the original UI.
