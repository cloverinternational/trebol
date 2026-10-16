# Glossary

The terms these pages use, in alphabetical order. Each entry says what the
term means in the plugin SDK and links to where it is covered in depth.

| Term | Meaning | See |
| --- | --- | --- |
| Action | A name the keymap can run: a built-in command id (`new_tab`), a keymap-only action (`palette`, `goto_tab:3`), a view chord (`editor.toggle_comment`), or a plugin action (`plugin.<plugin>.<id>`). `tern.bind` binds chords to actions; status segments run one on click | [Built-in Actions](actions.md) |
| `available` | A window command's optional predicate, called each time the palette lists rows; a falsy result hides the row. 4 ms budget | [Window API](api-window.md#terncommand) |
| Block | A pane whose program is Lua: a block type defined by a plugin's host half and started by the palette, "Open with", a route decision, `cx:new_block` or a workspace. It lives in the daemon's pane table like a shell and draws through the surface protocol | [Blocks](../guides/blocks.md), [Host API](api-host.md#ternblockdefine) |
| Block cx | The `cx` every block handler receives: effects plus `pane`, `cwd`, `cols`, `rows`, `render`, `save`, `exit`, `frame`, `blob` | [Host API](api-host.md#block-cx) |
| Block type | A `[[blocks]]` declaration plus its `tern.block.define` implementation | [Manifest Reference](manifest.md#blocks) |
| Budget | The time limit on one call into Lua: 2 s on the host, 50 ms in a window, 4 ms for chrome formatters and `available`. A call that runs past it fails and its hook is disabled until reload | [Runtime, Budgets, and JIT](../concepts/runtime.md#budgets) |
| Catalog | What a host's plugins provide, as data: every plugin's id, name, version, status, block types, lens rules and concatenated styles, plus the folder's problems. The host sends it to every window, iOS and the web tab, so they list block types and make lens claims without running Lua | [Architecture](../concepts/architecture.md#the-catalog) |
| Chord | A key combination as `tern.bind` and `keys` spell it (`cmd+shift+h`), or a sequence of them (`ctrl+a>c`) | [Built-in Actions](actions.md#chords) |
| Chrome | The window around the panes: tab titles, the window title, the status line. Plugins shape it with formatters and CSS | [Chrome and Styling](../guides/chrome.md) |
| Claim | A lens's decision to take a command line, made by the manifest's `match` globs alone: the first Ready plugin by id, then its first lens in manifest order whose glob matches `program args…`. Claims are declarative so every replica reaches the same decision | [Manifest Reference](manifest.md#match-patterns) |
| Command | A palette row. Built-in commands have ids (`split_right`); a plugin registers its own with `tern.command`, named `plugin.<plugin>.<id>` | [Window API](api-window.md#terncommand), [Built-in Actions](actions.md#commands) |
| Context | Which half a VM runs: `tern.context` is `"host"` or `"window"`. Each context has its own members | [API Reference](api.md#contexts) |
| cx | The handler context object passed to a handler: an effect cx, a block cx or a window cx, depending on the caller. A window `cx` is valid only during the call that received it | [API Reference](api.md#contexts) |
| Daemon | The session daemon: the per-user process that owns the panes and runs the host halves for this machine. Windows attach to it | [Architecture](../concepts/architecture.md#where-each-half-runs) |
| Data folder | `<state>/plugin-data/<id>/`, shared by both halves of a plugin: `tern.plugin.data`, `TERN_PLUGIN_DATA`, home of `kv.json` | [Packages and Manifests](../concepts/packages.md#the-data-folder) |
| Decision | What a `tern.route.open` or `tern.route.link` handler returns to take over an open or a link: `{block = kind, args?}`, `{url = …}`, `{path = …, how?}` or `{handled = true}`; `nil` declines | [Window API](api-window.md#route-decisions) |
| Disabled | A plugin status: turned off by the `plugins` or `plugins_disabled` setting. It loads nothing and claims nothing | [Packages and Manifests](../concepts/packages.md#problems-and-statuses) |
| Disabled hook | A hook whose call tripped its budget: later calls of it in that VM are skipped until the next reload | [Runtime, Budgets, and JIT](../concepts/runtime.md#a-tripped-budget) |
| Dock, layer, main | The three regions of a block's view: `main` is the block's area, `dock` a strip under it, `layer` above it | [Host API](api-host.md#view-model) |
| Effect | A request host Lua makes of the windows showing a pane: a toast, an open, or a clipboard copy. Effects travel from the host to the windows as data | [Host API](api-host.md#effect-cx) |
| Effect cx | The `cx` of lens `open` and `event` and of host event handlers; it has only `toast`, `open` and `copy` | [Host API](api-host.md#effect-cx) |
| Entry | The Luau file a context runs at load: the manifest's `host` or `window` | [Manifest Reference](manifest.md#host-window) |
| Event | A notification `tern.on` subscribes to. Host events (`command_finished`, `pane_exited`, …) and window events (`focus`, `tab_created`, …) are separate sets | [Events](events.md) |
| Failed | A plugin status: its entry raised or tripped its budget while loading, or left a declared block or lens undefined | [Errors](errors.md#load-failures) |
| Formatter | A pure window function that computes chrome text: `tern.chrome.tab_title`, `window_title` or `status`. It gets a small input table, no `cx`, a 4 ms budget, and its results are cached by input until `tern.chrome.refresh()` or a reload | [Window API](api-window.md#chrome-formatters) |
| Frame | One batch of surface protocol ops a block sends: the diff between two views, or raw ops from `cx:frame`. Frames over 64 KiB are chunked | [Host API](api-host.md#view-model) |
| Glob | A pattern with `*` (any run) and `?` (one character). Lens `match` globs are case-sensitive over the command; block `files` globs ignore ASCII case over the file name | [Manifest Reference](manifest.md#match-patterns) |
| Half | One of a plugin's two parts: the host half (`host.luau`) and the window half (`window.luau`). They usually run in different processes, often on different machines; on the same machine they share only the data folder | [Architecture](../concepts/architecture.md#the-two-halves) |
| Hook | The name a call into Lua runs under (`pods.view`, `command <id>`, `focus`, `timer`). It appears in failure toasts and is the unit a budget trip disables | [Runtime, Budgets, and JIT](../concepts/runtime.md#a-tripped-budget) |
| Host | A machine whose panes Tern runs: this machine, or a remote host a window attaches to. Each host runs its own installed plugins' host halves for its own panes | [Architecture](../concepts/architecture.md#where-each-half-runs) |
| Host half | The part of a plugin in `host.luau`: block types, lenses, host events, the spawn filter, `tern.pane`. It runs in a worker on the host that runs the panes | [Host API](api-host.md) |
| How | Where a file opens: `default`, `beside` (or `split`), `below`, `tab`, `replace` or `preview` | [Window API](api-window.md#route-decisions) |
| Kind | A block type's full name, `<plugin>.<block>` (`k8s.pods`). Route decisions, `cx:new_block` and `launch.block` take it | [Packages and Manifests](../concepts/packages.md#ids-and-names) |
| Launch | A table describing what a new pane runs: `cwd`, `command`, or `block` with `args` | [Window API](api-window.md#launch) |
| Lens | A plugin's native view of a command's output. The manifest's globs claim the command; the host half's `open`, `line`, `finish` and `view` turn the captured lines into a view shown in a lens block | [Command Lenses](../guides/lenses.md), [Host API](api-host.md#ternlensdefine) |
| Lens block | The block in a shell pane that holds a claimed command's raw output and shows its lens view; Raw shows the output itself | [Architecture](../concepts/architecture.md#lenses-declarative-claims-views-out-of-band) |
| Lens id | `plugin.<plugin>.<lens>`; a lens block's role is `lens.` followed by it | [Packages and Manifests](../concepts/packages.md#ids-and-names) |
| Lens state | The value a lens's `open` returns, kept by the worker for the latest 256 captures per plugin and rebuilt by rehydration | [Host API](api-host.md#lens-state-and-rehydration) |
| Link | A `<name>.path` file in the plugins folder naming a package directory elsewhere; `tern plugin link` writes it. Also: a hyperlink clicked in a pane, which `tern.route.link` may take | [Command Line](cli.md#tern-plugin-link) |
| Manifest | `plugin.toml`, schema 1 | [Manifest Reference](manifest.md) |
| Node | One element of a view: `{k = kind, p = props, c = children}`, built with `tern.ui` | [UI Builders](ui.md#nodes-and-spans) |
| Override | A window handler that runs before a built-in command (`tern.override`); a truthy return skips the built-in | [Window API](api-window.md#ternoverride) |
| Package | A directory with `plugin.toml`, its entries, styles and modules | [Packages and Manifests](../concepts/packages.md) |
| Plugin order | Plugin id order, and within one plugin registration order. Everything plugins take turns at (overrides, routes, formatters, the spawn filter, claims, window events) runs in it | [Lifecycle and Reload](../concepts/lifecycle.md#loading) |
| Plugins folder | `<config>/plugins/` (`tern plugin dir`), or the Files app's Tern › Plugins on iOS | [Packages and Manifests](../concepts/packages.md#the-plugins-folder) |
| Problem | A plugins-folder entry that is not a usable plugin, with the reason | [Errors](errors.md#plugins-folder-problems) |
| Ready | A plugin status: loaded and running | [Packages and Manifests](../concepts/packages.md#problems-and-statuses) |
| Region | See Dock, layer, main | |
| Rehydration | Rebuilding a lens block's state after the worker lost it (reload, daemon restart, eviction): the host replays the block's saved command and raw output through `open`, `line` and `finish` before handling the block's event | [Lifecycle and Reload](../concepts/lifecycle.md#lens-rehydration) |
| Reload | Dropping a context's VMs and loading every plugin again, after a change in the plugins folder, `tern plugin reload`, or Preferences. Running blocks restart from their last `save` | [Lifecycle and Reload](../concepts/lifecycle.md#reloading) |
| Replica | One copy of a pane's screen: the daemon's, each attached window's, iOS's, the web tab's. Only the host runs Lua; replicas learn claims from the catalog and views from the host | [Architecture](../concepts/architecture.md#lenses-declarative-claims-views-out-of-band) |
| Role | A string a node or block exposes for CSS: a node's `role` prop becomes `data-role`; a lens block's role is `lens.plugin.<plugin>.<lens>`; a plugin block's surface carries `data-surface="plugin.<plugin>.<block>"` | [Chrome and Styling](../guides/chrome.md) |
| Route | A window handler consulted before Tern opens a file (`tern.route.open`) or a clicked link (`tern.route.link`); the first decision wins | [Routing Opens and Links](../guides/routing.md) |
| Segment | One item a `tern.chrome.status` formatter adds to the status line: text, optional icon, tone and click action | [Window API](api-window.md#ternchromestatus) |
| Session | A named set of tabs in a window, as `cx.session` reads it; a window can hold several | [Layout and Workspaces](../guides/layout.md) |
| Sheet | A global style sheet in a window's cascade: a plugin's manifest styles (`plugin:local:<id>:styles`), a `tern.css` sheet (`plugin:local:<id>:<name>`), or a remote host's plugin styles (`plugin:<host>:<id>:styles`) | [Chrome and Styling](../guides/chrome.md) |
| Span | A run of styled text in a node: `{t = text, s = style?}` | [UI Builders](ui.md#spans) |
| Spawn filter | The host `spawn` event: a synchronous handler that may rewrite every process pane's program, arguments, directory and environment before it starts, waited on for at most 50 ms per plugin | [Events](events.md#the-spawn-filter) |
| State | A block's value returned by `init`, passed to every handler, persisted through `save`; or a lens capture's value returned by `open` | [Host API](api-host.md#blockdef) |
| Status | Ready, Disabled or Failed; each half keeps its own | [Lifecycle and Reload](../concepts/lifecycle.md#the-catalog-and-statuses) |
| Surface | The structured-view layer of a pane's screen that blocks and lens blocks draw into, over the surface protocol | [Building Views](../guides/views.md) |
| Tone | A semantic color name for spans, badges, rows and segments: `accent`, `success`, `warning`, `error`, `info`, `muted`, … | [UI Builders](ui.md#nodes-and-spans) |
| View | What a block's `view` or a lens's `view` returns: regions of nodes for a block, one node for a lens | [Building Views](../guides/views.md) |
| VM | One Luau virtual machine: one per plugin on each host (in its worker) and one per plugin in each window. Sandboxed, 256 MiB, budgeted. Nothing is shared between VMs except the data folder | [Runtime, Budgets, and JIT](../concepts/runtime.md#the-vm) |
| Window cx | The `cx` of commands, binds, overrides, routes, window events, window timers, process and fetch callbacks: `session`, `layout`, `run`, `open`, `new_block`, `command`, `toast`, `copy` | [Window API](api-window.md#window-cx) |
| Window half | The part of a plugin in `window.luau`, run in every Tern window on the UI thread: commands, binds, overrides, routes, formatters, CSS, window events, layout | [Window API](api-window.md) |
| Window key | The key that names a window's sessions in the daemon; panes see it as `$TERN_WINDOW_KEY`, and `tern` commands pick one with `--window`. A host effect goes to every window with the pane's window key | [Command Line](cli.md#common-behavior) |
| Worker | The thread a host runs one plugin's host half on, with its own VM. Workers run in parallel; each handles its plugin's requests, events and callbacks one at a time | [Architecture](../concepts/architecture.md#host-workers) |
| Workspace | A tab layout a window half builds with `cx.layout`, typically from `window_start` | [Layout and Workspaces](../guides/layout.md#workspaces) |
