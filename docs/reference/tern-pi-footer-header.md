# Tern Pi input header and footer: verified provenance

The native Pi-Swarm footer owner is
`extensions/conversation-metrics/extension.ts`. It owns Pi's one
`ctx.ui.setFooter` slot, restores its `pi-conversation-metrics` entry on
`session_start`, marks activity on `agent_start`, accumulates actual
`message_end` output usage, stops the clock on settled/shutdown, and refreshes
its TUI every 500 ms while present. In this session a Tern capture of the
*native Pi TUI* showed `trebol / main`, `sol`, `WORKING`; then
`Context 51%`, `↓ 123.8k out · 2h 01m active`; then
`Autogen 53/90 · Skill: software-engineering-and-delivery`. Those are
observed values, not defaults for other sessions.

The separate TSP frontend does **not** call `ctx.ui.setFooter`; it is its
process's sole renderer. `.pi/lib/tern/bridge.ts` owns one `dock` with a
`header` status node, a program-owned `editor` composer, and `status` footer.
`.pi/lib/tern/metrics.ts` reads model identity from the active Pi session,
workspace from the runner's `cwd` basename, context percent from
`session.getContextUsage()` only when finite and nonnegative, and output
tokens only from real assistant `usage.output` on the active session's
persisted message entries or observed `message_end`. Its elapsed active time
starts only after this bridge observes `agent_start`; it cannot truthfully
recover prior active time from the SDK's exported state. It rebases on
session-ID change, stops timers on `agent_end`/`agent_settled`, and clears
them on close. When metrics APIs are missing, throw, return null (e.g. after
compaction), or return malformed values, the corresponding segment is
**omitted** rather than filled with zero or a guess.

In the TSP dock, the header order is workspace (if supplied), provider/model
(if available), then `running`/`idle`; the editor follows. The footer order
is context percent, output tokens, observed active time, and the existing
`perm: deny (no UI bound)` warning. The TSP bridge does **not** claim a Git
branch: native Pi's `FooterDataProvider.getGitBranch()` is not exposed to this
SDK session. Nor does it claim Autogen/Skill/auto or task hints: those are
conditional provider contributions in native Pi (`footerSegments()` map,
`runningWorkHint`), not guaranteed in the separate TSP process. A native
footer may also wrap or hide detail at narrower widths. No segment should be
copied from this session's capture into another session.

Verification: `.pi/test/tern/metrics.test.ts` and `dock.test.ts` check
session reset, malformed/missing usage, conditional segment order, timer
lifecycle, picker position and cleanup. Focused tests and a live Tern pane
are separate evidence: tests establish mapping; only a live pane can confirm
how Tern actually draws the status and editor nodes. The TSP frontend still
cannot present interactive extension approval dialogs; use `pi -nt` or
`PI_TERN_UI=0 pi` for the native Pi TUI when needed.

Live check of bare `pi` in Tern pane `1614907703298` confirmed foreground
TSP `run.ts`, but `tern capture --surfaces` returned only the surface's
**main** transcript; Tern documents that this command excludes `dock`.
It did not prove the header/footer's visual appearance or values. In that
probe the harmless prompt did not produce a captured reply before the pane
was closed, so no live metric transition is claimed. The native Pi footer
rows quoted above came from the separate already-running Pi TUI pane, not
from this TSP dock.
