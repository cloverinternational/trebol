# pi -r resume investigation

Evidence for task #2 (how `pi -r` opens and replaces sessions). Source is the installed Pi package at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist`, read in this session. Line numbers refer to those files.

## Entry point

- `cli/args.js:60-61`: `--resume` or `-r` sets `result.resume = true`.
- `main.js:328-330`: `if (parsed.resume)` calls `selectSession(...)` with `SessionManager.list(cwd, sessionDir)` and `SessionManager.listAll(sessionDir)`.
- `cli/session-picker.js:9-34`: `selectSession` builds a `SessionSelectorComponent` in its own startup TUI. It resolves with the chosen path, or `null` on cancel.

## Session list

- `main.js:330`: current-project list via `SessionManager.list(cwd, sessionDir, ...)`; all-sessions list via `SessionManager.listAll(sessionDir, ...)`.

## Replacement call

- Startup `-r`: `main.js:335` returns `SessionManager.open(selectedPath, sessionDir)`. This is not a runtime switch. On cancel, `main.js:13-14` prints "No session selected" and exits 0.
- In-session `/resume` and `app.session.resume`: `modes/interactive/interactive-mode.js:4753` (`showSessionSelector`) passes the chosen path to `handleResumeSession` (`:4779`), which calls `runtimeHost.switchSession(sessionPath, { withSession, ... })` (`:4782`).
- Extension API: `core/extensions/types.d.ts:316-317` declares `switchSession(sessionPath, { withSession })`. `docs/extensions.md:217` says session replacement invalidates the old context, so post-switch work must use the ctx passed to `withSession`.

## Limitations

- Startup `-r` and in-session `/resume` differ. A Tern replacement that mirrors in-session behavior should use `switchSession` and `withSession`.
- `docs/extensions.md` was read only at the cited lines (`:59`, `:203`, `:217`, `:233`), not in full.
