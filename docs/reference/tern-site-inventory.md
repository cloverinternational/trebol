# Tern Official Docs Site Inventory

Source: https://docs.stencil.so/tern/ (mdBook, title "Tern Plugin SDK"). Fetched independently of the GitHub SDK repo (stencil-hq/tern-sdk).

## Version and discovery

- Doc version: no explicit version string found on the site. The plugin manifest carries `schema = 1` (https://docs.stencil.so/tern/index.md).
- `/sitemap.xml` and `/tern/sitemap.xml`: 404. No sitemap published.
- `/tern/llms.txt`: 404.
- `/tern/print.html`: single-page full book (about 1.9 MB). Use it for whole-site search.
- Every page has a `.md` twin (e.g. `/tern/protocol/transport.md`), which is the cleanest source for reading.

## Page list

Top-level sections come from the root nav (https://docs.stencil.so/tern/):

- Overview: [index](https://docs.stencil.so/tern/)
- Concepts: [Architecture](https://docs.stencil.so/tern/concepts/architecture.html), [Packages and Manifests](https://docs.stencil.so/tern/concepts/packages.html), [Trust and Security](https://docs.stencil.so/tern/concepts/security.html)
- Guides: [Getting Started](https://docs.stencil.so/tern/guides/getting-started.html), [Blocks](https://docs.stencil.so/tern/guides/blocks.html), [Lenses](https://docs.stencil.so/tern/guides/lenses.html), [Commands](https://docs.stencil.so/tern/guides/commands.html), [Routing](https://docs.stencil.so/tern/guides/routing.html), [Chrome](https://docs.stencil.so/tern/guides/chrome.html), [Layout](https://docs.stencil.so/tern/guides/layout.html), [Hooks](https://docs.stencil.so/tern/guides/hooks.html), [Views](https://docs.stencil.so/tern/guides/views.html)
- Elements: [index](https://docs.stencil.so/tern/elements/index.html)
- Styles: [Styling Views](https://docs.stencil.so/tern/styles/index.html)
- Scripts: [index](https://docs.stencil.so/tern/scripts/index.html)
- Protocol (Surface Protocol, TSP): [index](https://docs.stencil.so/tern/protocol/index.html), [SDKs](https://docs.stencil.so/tern/protocol/sdks.html), [Transport](https://docs.stencil.so/tern/protocol/transport.html), [Handshake](https://docs.stencil.so/tern/protocol/handshake.html), [Surfaces](https://docs.stencil.so/tern/protocol/surfaces.html), [Documents and Frames](https://docs.stencil.so/tern/protocol/documents.html), [Input and Events](https://docs.stencil.so/tern/protocol/input.html), [Palette, Stylesheets and Icons](https://docs.stencil.so/tern/protocol/theme.html), [Flow Control, Persistence and Security](https://docs.stencil.so/tern/protocol/operations.html)
- Examples: [index](https://docs.stencil.so/tern/examples/index.html)
- Reference: [API Reference](https://docs.stencil.so/tern/reference/api.html)

## Section relevance

- Plugins: Overview (`index.md`) defines plugins as Luau packages with `plugin.toml` and up to two entries (`host.luau`, `window.luau`). Guides cover blocks, lenses, commands, routing, chrome, layout, hooks.
- Blocks: Guides/Blocks (`guides/blocks.md`) is the block guide. Overview states a host-defined block is an ordinary pane shared across windows.
- Agents: Protocol index names "a coding agent such as omp" as a program that speaks TSP. Elements include an `agent` node kind and `toggle` events for collapsible agent blocks (`protocol/handshake.md` kinds list; `protocol/input.md` event table). Guides/Blocks mentions an "agent block" as a command-run pane type.
- Process: Concepts/Architecture (session daemon, window, host vs window halves); Blocks "agent command" examples run through a login shell.
- Surfaces: Protocol/Surfaces (open/close, inline/screen/flow modes, anchoring) and Protocol/Documents (frames of ops).

## Streaming and duplex: can the public API drive a duplex agent?

Short answer: the public docs describe a bidirectional in-band channel, but not a documented agent-streaming API. Plugins cannot open a duplex stream; a program in a pane can use TSP.

Evidence:
- TSP travels over the pane's pty. Program to terminal: `q`, `o`, `f`, `b`, `t`, `s`, `x` verbs. Terminal to program: `r` replies and `e` events, arriving on the pty input side (https://docs.stencil.so/tern/protocol/transport.md, verb table, "Terminal → program messages travel on the pty's input side").
- Streamed output exists: a frame "that appends streamed Markdown and marks a card done" (transport.md, "A frame that appends streamed Markdown"). Large bodies are chunked with `c=<chunk-id>`, max 1 s between chunks (transport.md, Chunking).
- Flow control: `credits` is 2, meaning at most 2 unacknowledged frames; renders during waiting fold into one frame (handshake.md line ~52, 63; sdks.md line ~53; operations.md#flow-control).
- Plugins do not use TSP directly: "a plugin only returns views" (protocol/index.md, "Plugins don't need this part of the book").
- Official SDKs for TSP (Rust, Python, Go, TypeScript) live in the GitHub repo, which is out of scope for this inventory (protocol/sdks.md).
- Pages list no WebSocket, SSE, or agent-session API. A grep for stream/duplex/bidirectional/agent across fetched pages found no such API.

## Fetched sources (this run)

index.md, print.html, protocol/index.md, protocol/transport.md, protocol/handshake.md, protocol/input.md, protocol/sdks.md, reference/api.md, concepts/architecture.md, guides/blocks.md, guides/hooks.md, elements/index.md.

Not fetched in full: remaining guides, styles, scripts, examples, surfaces, documents, theme, operations, security, packages.

## Issues

- `/tern/tools/agent-and-task-kinds` returned 404; the "Agent and Task Kinds" heading in print.html has no matching URL.
- Read-only inventory. No tern-sdk or integration-map files were edited.
