# Native Tern MCP control center

## Agreed direction

User selected a floating control center and full management scope. No subagents.
`/mcp` opens a native Tern overlay, not transcript text or Pi's terminal custom UI.
Follow https://docs.stencil.so/tern/guides/design.md and the Surface Protocol:
semantic native components, theme tones, restrained CSS, one contextual primary
action, and complete loading/empty/error/success states.

## Implementation

1. Inspect the installed Pi MCP extension/CLI interfaces and pin a tested adapter
   boundary. Combine Pi-owned configuration metadata with the current session's
   live registry and observed connection information. Do not infer configuration
   from tool counts, invent health checks, or label last-observed readiness as
   continuous health. Preserve configured IDs separately from display labels and
   tool namespaces. Include disabled and tool-less configured servers.
2. Create focused MCP state/controller and pure TSP rendering modules beside the
   existing Tern panels. Keep bridge.ts to routing, lifecycle, and event wiring.
   Opening `/mcp` or clicking the startup MCP line opens one reusable overlay.
3. Build a large centered control center with title, refresh/close controls,
   meaningful summary counts, and Servers / Tools / Diagnostics tabs. Servers
   use a searchable selectable table alongside a selected-server inspector.
   Tools expose searchable names, descriptions, exposure, and schema details;
   inspecting a tool never calls it. Diagnostics explain registration, discovery
   and model availability separately, with sanitized actionable errors.
4. Use native overlay, table, tabs, input, card, kv, badge, button, scroll,
   skeleton, empty, spinner and toast nodes as appropriate. Preserve selection
   and search during refresh; support narrow panes, scrolling, focus and keyboard
   navigation. Escape closes the current nested view before the manager and
   restores the composer draft/focus. Do not steal model turns or leak typed
   search text into chat. Tern owns motion and layout.
5. Wire reconnect and sign-in/out to Pi's existing session handlers/APIs with
   explicit busy/success/failure feedback. Resolve actual installed API support
   before choosing calls; no duplicate connection stack. Add is a guided native
   form accepting existing JSON/URL/command input through the shared mcp-add
   parser, with scope selection, validation and a safe preview. Remove requires
   confirmation naming the server and scope and uses Pi's own configuration
   mutation path. Explain and offer reload where session configuration requires
   it; never imply a config write already updated live connections. Guard busy
   actions, duplicate submissions, stale session completions and disposal.
6. Never render/store raw auth headers, tokens or sensitive environment values
   in diagnostics, previews or transcript notices. Prefer credential references;
   preserve explicit confirmation for literal-secret persistence. No direct
   bespoke mcp.json writer. Preserve project trust and Pi's normal safeguards.
7. Refresh from current session state while open, using available lifecycle
   notifications and explicit Refresh; if bounded polling is needed, only while
   visible and fully cleaned up on close/session replacement. Retain live-registry
   correctness from the previous fix. No model request is needed to update UI.

## Verification and delivery

- Pure state/render tests: all four states, configured-without-tools, late
  registration, exposure changes, search, selection, narrow layout, unknown
  health, safe error/metadata output, and stable node identities.
- Bridge/action tests: open/click/close, keyboard and native edit events,
  unchanged draft, no model turn, single-flight operations, confirmations,
  cancel/error paths, reload behavior and lifecycle cleanup.
- Adapter tests exercise installed Pi interfaces with temporary isolated
  configuration and deterministic fixtures; no mutations to personal servers.
- Run relevant MCP/bridge suites, Tern style lint and diff checks. Validate the
  actual native rendering with a Tern screenshot and interaction smoke test where
  available, not only serialized node assertions. Report any live-verification
  limitation explicitly; no real auth/config changes solely for screenshots.
- Update AGENTS.md, changelog and relevant architecture/reference notes. No
  changes to vendor or unrelated user work; no automatic commit/push.

## Non-goals

No new MCP client, arbitrary tool-execution playground, fabricated latency charts,
background network health probes, or unrelated Tern plugin redesign.

## Implementation verification

Implemented in mcp-host.ts, mcp-controller.ts and mcp-panel.ts, wired through
pi-builtins.ts, bridge.ts, run.ts and the startup MCP line. No subagents used.
Final targeted run: 53 test files / 610 tests passed, including the separately
preserved terminal-component MCP adapter tests added by a concurrent merge.
The three new implementation modules pass focused TypeScript checking and
`git diff --check` passes. The broader bridge TypeScript graph has existing errors.

`node tools/e2e/tern-mcp-panel.mjs` rendered seven native fixture views, including
480px and 1400px server layouts, tool schemas, diagnostics, Add, preview and Remove.
Screenshots and native element trees are under artifacts/tern-mcp; wide/narrow
server views and the tool explorer were visually inspected. Automated event tests
cover modal edits, selection, confirmation and lifecycle. A physical live-window
pointer/OAuth round trip was not performed. Real browser sign-in completion remains
unverified; no personal server configuration was modified for validation.

Repository style lint runs but reports 58 errors and 16 warnings in existing
composer/recorded-session styles, not the new manager (which adds no CSS).
