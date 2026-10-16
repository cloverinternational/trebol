# Window API

The window context runs `window.luau` in every Tern window on the machine,
each window with its own VM per plugin, on that window's UI thread. It owns
palette commands, key binds, overrides of built-in commands, routing of file
opens and link clicks, chrome formatters, global CSS, window events and
layout scripting. Because it shares the UI thread, its budgets are short:
50 ms per call (including running the entry at load), 4 ms for chrome
formatters and `available` checks. See
[Runtime, Budgets, and JIT](../concepts/runtime.md).

The web client runs no Lua, so window halves don't exist there. iOS runs
them interpreted.

## Carly's Lua tool

On desktop Carly uses a separate, conversation-local Luau VM with the same
window `cx`. `lua` calls retain globals until `/new` or daily rollover;
plugin reloads do not reset them. Window registration APIs are absent; `loadstring`
and ordinary environment/filesystem/process/network/window APIs are available.
Use `help("cx.session")` or `help("tern.process")` to discover shared declarations.

```lua
local pane = cx.session:focused()
cx:run(pane, "pwd\r")
return await(cx.session:settle(pane, 30000))
```

`cx.session:settle(pane, ms?) -> Awaitable<string>` waits for shell completion
(OSC 133) or its deadline and returns the last output lines. It defaults to
30000 ms, capped at 120000; closing the pane fails it. Plugins consume the
same awaitable with `:next(function(text, err, cx) … end)`, which gets a fresh
context. Carly uses `await` or `await_all({a, b})`. Her `cx` and its session,
layout, canvas and browser objects remain valid across preemption and awaits;
stored references resolve against the current live call. Using them outside a
live call raises an error. Plugin contexts still expire when their handler returns.

Prints and returned values become Carly's tool answer; `_` and `_out` retain
the full first return and print text. Saved workspace `snippets/*.luau`
modules are loaded explicitly with `require("name")`, never automatically.
Headless `carly lua "<code>"` stores the raw answer in `state.carly.last_tool`;
its card displays it as a fenced code block to preserve prints and traceback
line breaks. The model-facing tool answer remains plain text.
Carly has ordinary window-plugin API capabilities: environment reads, filesystem
reads and writes, processes, network requests, typing into any specified pane and
window manipulation. Relative file paths use her VM's working directory, not a
write boundary. Argument validation, operation errors, deadlines and resource
budgets still apply. 

## Carly exports and request context

`tern.carly` is installed in desktop window plugin VMs (not host, web or iOS).
See [Extending Carly](../guides/carly.md) for capabilities and examples.

| Registration | Contract |
| --- | --- |
| `tern.carly.export(name, {sig, doc}, fn)` | Registers/replaces a documented export; name `[a-z][a-z0-9_]{0,23}`, max 16, sig/doc each 1–1024 bytes |
| `tern.carly.context(fn)` | Replaces the request provider; `fn(cx) -> string?`, 4 ms, 400 characters per plugin and 1600 total |

Every loaded local window plugin's registered exports and context are available to
Carly by default. `help()` lists the exports and `help("plugins.<id>")` shows their
signatures and docs.

Carly invokes `await(plugins[id][name](...))`. Arguments cross through JSON values;
the function receives those positional arguments followed by a fresh ordinary
window-plugin `cx` and an `ExportCall`. It has the normal 50 ms plugin budget.
A synchronous return resolves an awaitable immediately; multiple returns become an
array. No return and no reply is an immediate error.

`ExportCall` survives in timer/process/fetch callbacks:

- `call:reply(value) -> boolean`: answer once with a JSON-safe value.
- `call:fail(message) -> boolean`: fail once.
- `return call:wait(ms?)`: wait for a callback, default 30000 ms, capped at 120000.
- `call.cancelled`: true after completion, cancellation, expiry or reload.

Late replies return false. Values are capped at 16 KiB; functions, userdata, threads,
cycles and non-finite numbers fail with the offending path. Reload fails pending
calls with `plugin <id> reloaded before answering`. Cached Carly-side export
functions look up the new implementation at call time.

Context appends a **Plugins** section and
advertises registered exports from every loaded local window plugin. Errors and
over-budget providers never block a question. Export handlers and later callbacks
have ordinary plugin API capabilities.

## Registration

Every registering member (`tern.command`, `tern.bind`, `tern.override`,
`tern.route.*`, `tern.chrome.*`, `tern.css`, `tern.on`, `tern.carly.export`,
`tern.carly.context`) may be called while
the entry loads or later, from any handler. Registrations made during a call
take effect when the call returns: the palette rows, the keymap's plugin
layer and the formatters are read again, and new sheets are installed. A
reload drops them all with the VM and runs the entry again.

Plugins are ordered by id. "Plugin order" below means that order, and within
one plugin, registration order.

## Pane and tab ids

Pane and tab ids are Lua numbers. A pane on a remote host carries a host tag
that Tern moves from bit 56 down to bit 44 for Lua, so the id stays exact in
a double. Pass ids back unchanged, as received from `cx.session`, payloads
and `cx.layout` results; don't compute with them or compare them across
windows.

## `tern.command`

```lua
tern.command: (def: CommandDef) -> ()

type CommandDef = {
	id: string,
	title: string,
	icon: string?,
	group: string?,
	keys: { string }?,
	available: ((cx: WindowCx) -> boolean)?,
	run: (cx: WindowCx) -> (),
}
```

Adds a palette row and the action `plugin.<plugin>.<id>`, which key binds
(`tern.bind`, `settings.json` `keybinds`) and status segments can name.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | ASCII letters, digits, `_` and `-`; not `bind` |
| `title` | yes | Palette label |
| `icon` | no | A Tern icon name; unknown or absent shows `puzzle` |
| `group` | no | Palette group (default: the plugin's `name`) |
| `keys` | no | Default chords, each bound to the action as `tern.bind` would (`"cmd+shift+h"`, sequences `"ctrl+a>c"`) |
| `available` | no | Called each time the palette lists rows; a falsy result hides the row. 4 ms budget, hook `available plugin.<plugin>.<id>`; an error hides the row |
| `run` | yes | Runs the command, hook `command <id>`, 50 ms |

Raises ``tern.command: bad id `<id>` (letters, digits, `_` and `-`; not
`bind`)``, and a conversion error when `title` is not a string or `run` is
not a function.

Registering an `id` again replaces the row; its `keys` are added to the
binds already registered.

```lua
tern.command({
	id = "scratch",
	title = "Open scratch file",
	icon = "file",
	keys = { "cmd+alt+j" },
	run = function(cx)
		cx:open(tern.plugin.data .. "/scratch.md", "beside")
	end,
})
```

## `tern.bind`

```lua
tern.bind: (chord: string, action: string | ((cx: WindowCx) -> ())) -> ()
```

| Parameter | Type | Meaning |
| --- | --- | --- |
| `chord` | `string` | Keys as `settings.json` `keybinds` spells them: `+`-joined modifiers (`ctrl`, `alt`/`opt`, `shift`, `cmd`/`super`) and a key, sequences `>`-joined |
| `action` | `string` or function | An action name ([Built-in Actions](actions.md)), or a function |

A function gets the action name `plugin.<plugin>.bind.<n>`, where `n` counts
this plugin's function binds from 0 in registration order; it runs with a
fresh `cx` as hook `bind <n>`.

Raises `tern.bind: the action is a name or a function`. Nothing else is
checked at the call: the keymap reads the bind when it is rebuilt, and leaves
it out, logging `plugin bind left out`, when the chord or the action name
doesn't parse, or when Tern's defaults or the keyboard preset already bind
the chord, a sequence it starts, or a sequence that starts with it. A user's
`keybinds` entry for the same keys replaces the plugin's.

Keymap layers, lowest first: Tern's defaults and the keyboard preset, the
plugins' binds, the user's `keybinds`. See
[Commands, Keys, and Overrides](../guides/commands.md#keymap-layering).

```lua
tern.bind("ctrl+alt+shift+h", "plugin.hello.say_hi")
tern.bind("ctrl+alt+shift+t", function(cx)
	local pane = cx.session:focused()
	if pane then
		cx:run(pane, "cargo test\r")
	end
end)
```

## `tern.override`

```lua
tern.override: (command_id: string, fn: (cx: WindowCx) -> boolean?) -> ()
```

Runs `fn` before built-in command `command_id` each time it runs, from the
palette, a key, a menu, or another part of Tern. Overrides run in plugin
order; the first that returns a truthy value stops the rest and skips the
built-in. A handler that raises counts as `false`. Hook name
`override <command_id>`.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `command_id` | `string` | A built-in command id ([Built-in Actions](actions.md#commands)) |
| `fn` | function | Returns `true` to replace the built-in |

Raises ``tern.override: unknown command `<id>` ``. Only palette commands can
be overridden; other action names (`palette`, `goto_tab:N`, `edit.*`, …) are
not commands.

While any plugin handler runs, the window's plugins are out of reach: a
built-in reached from a handler (`cx:command`, `cx:open`, `cx.layout:new_tab`)
runs Tern's own behavior with no overrides and no routes. An override can
therefore call its own command without recursing:

```lua
tern.override("new_tab", function(cx)
	cx:toast("info", "New tab")
	cx:command("new_tab")
	return true
end)
```

## `tern.route.open`

```lua
tern.route.open: (fn: (req: OpenRequest, cx: WindowCx) -> RouteDecision?) -> ()

type OpenRequest = {
	path: string,
	line: number?,
	col: number?,
	host: string,
	how: How,
	origin: Origin,
}

type How = "default" | "beside" | "below" | "split" | "tab" | "replace" | "preview"
type Origin = "palette" | "files" | "drop" | "link" | "system" | "cli" | "carly"
```

Registers a handler for file opens a person asks for. Handlers run in plugin
order until one returns a decision; with none, Tern opens the file itself.
Hook name `route.open`.

| Field | Meaning |
| --- | --- |
| `path` | Absolute path; canonical (symlinks and `..` resolved) when it exists |
| `line`, `col` | Position to reveal, 1-based, when the request names one |
| `host` | Name of the host the file lives on |
| `how` | Where it would open: `default`, `beside`, `below`, `split`, `tab`, `replace` (in place of the focused block), `preview` |
| `origin` | What asked: `palette`, `files` (the Files pane), `drop`, `link` (a file link in a pane or file block), `system` (Finder's Open With, the Dock), `cli` (`tern open`), `carly` (Carly's window context) |

`tern open` in a daemon pane is relayed to a window that takes opens, where
this route runs. Opens Tern makes on its own (restoring state, git and board
views, Files previews) don't route.

```lua
tern.route.open(function(req, _cx)
	if req.path:sub(-5) == ".json" and req.how ~= "replace" then
		return { block = "jsonx.viewer", args = { req.path } }
	end
	return nil
end)
```

## `tern.route.link`

```lua
tern.route.link: (fn: (link: LinkRequest, cx: WindowCx) -> RouteDecision?) -> ()

type LinkRequest = {
	url: string,
	pane: number?,
	mods: { cmd: boolean, alt: boolean, shift: boolean, ctrl: boolean },
}
```

Registers a handler for link clicks in panes, the link menu's "Open link"
items, opens requested by host plugins and surfaces, and URLs the system
hands Tern. It runs before any built-in handling, so it can claim custom
schemes and paths that don't exist. Hook name `route.link`.

| Field | Meaning |
| --- | --- |
| `url` | The link as clicked (`https://…`, `file://…`, a path, a custom scheme) |
| `pane` | The pane the link is in; `nil` when there is none (the declaration says `number`) |
| `mods` | Modifiers held: `cmd` (⌘, Super on PCs), `alt`, `shift`, `ctrl` |

```lua
tern.route.link(function(link, cx)
	local ticket = link.url:match("^jira://(%u+%-%d+)$")
	if ticket then
		cx:open("https://example.atlassian.net/browse/" .. ticket)
		return { handled = true }
	end
	return nil
end)
```

## Route decisions

```lua
type RouteDecision = {
	block: string?,
	args: { string }?,
	url: string?,
	path: string?,
	how: How?,
	handled: boolean?,
}
```

A handler returns `nil` to pass, or a table. The first field present, in the
order below, decides; the others are ignored.

| Decision | From `route.open` | From `route.link` |
| --- | --- | --- |
| `nil` | Next handler, then the built-in open | Next handler, then the built-in handling |
| `{ block = "<plugin>.<id>", args = {…} }` | Opens that plugin block with `args` on the file's host (`req.host`), in the file's directory, placed by the request's `how` | Opens the block on the clicked pane's host, in the pane's directory, beside the pane when ⌥ was held |
| `{ url = "…" }` | Treats the URL as a clicked link: link routes see it once, then the built-in handling | The built-in link handling of that URL (routes don't run again) |
| `{ path = "…", how = … }` | Replaces the path (and the placement, when `how` is set), then the built-in open | Opens the path in a file block on the pane's host, placed by `how` (default: beside with ⌥, else default) |
| `{ handled = true }` | Nothing else runs | Nothing else runs |

A route whose `block` names a kind no Ready plugin on that host defines
opens nothing and toasts an error: "Could not open the block", with `No
plugin on <host> defines block type <kind>` beneath (also logged as `no
plugin block type for a route decision`). The decision still counts: the
built-in open doesn't run.

A bad result is reported as a failure of the route's hook and counts as
`nil`:

- `a route returns a decision table or nil`;
- ``a route decision has an unknown how `<how>` ``;
- `a route decision sets block, url, path or handled = true`.

## Chrome formatters

Pure functions over a small input table: no `cx`, 4 ms budget, hook names
`tab_title`, `window_title` and `status`. Each plugin has one formatter of
each kind (a later call replaces it). Results are cached per distinct input
(up to 256 inputs per kind, then the cache starts over) and the cache is
cleared whenever a plugin's registrations change or a plugin calls
[`tern.chrome.refresh`](#ternchromerefresh), so otherwise a formatter runs
again only when its input changes. Failures are toasted at the window's
next poll; a formatter that runs past 4 ms is disabled until the next
reload.

### `tern.chrome.tab_title`

```lua
tern.chrome.tab_title: (fn: (tab: TabInfo) -> string?) -> ()

type TabInfo = {
	id: number,
	name: string?,
	cwd: string?,
	program: string,
	title: string,
	panes: number,
	busy: boolean,
}
```

The tab's title from the first plugin whose formatter returns a non-empty
string; `nil` or `""` keeps Tern's.

| Field | Meaning |
| --- | --- |
| `id` | Tab id |
| `name` | The name the user gave the tab, if any |
| `cwd` | The focused pane's working directory (`""` when unknown) |
| `program` | The focused pane's program |
| `title` | The focused pane's title |
| `panes` | Number of panes in the tab |
| `busy` | Whether a command runs in any of them |

Returning anything other than a string or `nil` fails with `a title
formatter returns a string or nil`.

### `tern.chrome.window_title`

```lua
tern.chrome.window_title: (fn: (win: WindowInfo) -> string?) -> ()

type WindowInfo = { [string]: any }
```

The window's title from the first plugin whose formatter returns a non-empty
string. The runtime passes these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `space` | `string` | The current session's name |
| `tab` | `string?` | The active tab's title |
| `pane` | `number?` | The focused pane |
| `cwd` | `string?` | The focused pane's working directory |
| `tabs` | `number` | Number of tabs in the current session |

### `tern.chrome.status`

```lua
tern.chrome.status: (fn: (pane: StatusPaneInfo) -> { StatusSegment }?) -> ()

type StatusPaneInfo = {
	pane: number,
	cwd: string?,
	program: string,
	title: string,
	busy: boolean,
}

type StatusSegment = {
	text: string,
	icon: string?,
	tone: string?,
	command: string?,
}
```

Status line segments for the focused pane. Every plugin's segments show, in
plugin order; `nil` adds none. The declaration types `cwd` as optional; the
window always sets it, to `""` when the directory is unknown.

`busy` is true while shell integration reports a running command and false
after it finishes or the pane's program exits. It is part of the formatter
cache key; it does not infer activity for programs without shell integration.

| Segment field | Meaning |
| --- | --- |
| `text` | Its text (required) |
| `icon` | A Tern icon name, shown before the text |
| `tone` | Sets `data-tone` (`"accent"`, `"muted"`, `"error"`, …) |
| `command` | Any action name ([Built-in Actions](actions.md)), run on click |

Segments render as `<span class="sl-plugin" data-plugin="<id>">` inside the
status line, with `data-tone` when set, and class `on` and `role="button"`
when clickable. A `command` that doesn't parse toasts "A status segment's
command is unknown" on click. A result that isn't a list or `nil` fails with
`a status formatter returns a list of segments or nil`.

```lua
tern.chrome.status(function(pane)
	if pane.program == "kubectl" then
		return { { text = "k8s", icon = "box", tone = "accent", command = "plugin.k8s.contexts" } }
	end
	return nil
end)
```

### `tern.chrome.refresh`

```lua
tern.chrome.refresh: () -> ()
```

Drops this window's cached results of every formatter and wakes the window,
which redraws its tabs, status line and title on the next frame: every
formatter runs again with the current input. Call it after data a formatter
reads outside its input changes (an upvalue fed by a timer, a process, an
event). Other windows keep their caches; each runs its own window half.

Raises `tern.chrome.refresh: not from a formatter` when called from a
formatter. A ticking segment refreshes from a timer only while there is
something to count:

```lua
local started: { [number]: number } = {}
local tick: TimerHandle? = nil

local function schedule()
	if tick == nil and next(started) ~= nil then
		tick = tern.timer(1000, function()
			tick = nil
			tern.chrome.refresh()
			schedule()
		end)
	end
end

tern.on("command_started", function(ev, _cx)
	started[ev.pane] = tern.now()
	schedule()
end)
tern.on("command_finished", function(ev, _cx)
	started[ev.pane] = nil
	tern.chrome.refresh()
end)

tern.chrome.status(function(pane)
	local since = started[pane.pane]
	if since == nil then
		return nil
	end
	return { { text = string.format("%ds", (tern.now() - since) // 1000), icon = "clock" } }
end)
```

## `tern.css`

```lua
tern.css: (name: string, source: string) -> ()
```

Installs `source` as global style sheet `plugin:local:<plugin>:<name>`, after
Tern's own sheets, or replaces the sheet of that name. The manifest's
`styles` are sheet `plugin:local:<plugin>:styles`.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | ASCII letters, digits, `_` and `-`; not `styles` |
| `source` | `string` | CSS |

Raises ``tern.css: bad name `<name>` (letters, digits, `_` and `-`; not
`styles`)``. CSS parse errors don't raise; they are logged as `plugin style
sheet has errors`. A reload removes every plugin sheet and installs them
again. (`tern.d.luau` names the sheet `plugin:<plugin>:<name>`; the runtime
uses the `local` segment shown here.) The web tab runs no window entry, so
`tern.css` sheets never reach it; it installs the manifest `styles` of its
daemon's Ready plugins from the catalog.

A plugin block's region elements (`.sf-main`, `.sf-dock`, `.sf-layer`) carry
`data-surface="plugin.<plugin>.<id>"`; lens blocks carry
`.sf-block[data-role="lens.plugin.<plugin>.<id>"]`. See
[Chrome and Styling](../guides/chrome.md).

```lua
tern.css("status", [[
#statusline .sl-plugin[data-plugin="k8s"] { color: var(--accent); }
]])
```

## `tern.on`

```lua
tern.on: (name: string, fn: (...any) -> ...any) -> ()
```

Subscribes `fn` to window event `name`. The handler receives the payload and
a fresh `cx`, except `window_start`, which receives only `cx`.

| Event | Handler |
| --- | --- |
| `window_start` | `(cx)` |
| `focus` | `({pane, tab}, cx)` |
| `pane_created`, `pane_closed` | `({pane}, cx)` |
| `tab_created`, `tab_closed` | `({tab}, cx)` |
| `command_started` | `({pane, line}, cx)` |
| `command_finished` | `({pane, line, status, took_ms}, cx)` |
| `cwd` | `({pane, path}, cx)` |
| `title` | `({pane, title}, cx)` |
| `canvas_action` | `(ev: CanvasAction, cx) -> boolean?`, only for canvases owned by this plugin |

Raises ``tern.on: unknown window event `<name>` ``. Hook names are the event
names. [Events](events.md#window-events) covers when each fires and in what
order.

## Window cx

Carly uses the same window methods and capabilities as a loaded window plugin:
typing into any specified pane, toast and clipboard effects, layout changes,
creation, focus, reveal, close and every command or action. Focus and reveal
use ordinary plugin defaults; pane closes use the raw session operation, not a
Carly-specific confirmation guard. Argument validation, unknown targets and
underlying operation failures still apply.

Plugin opens remain route-free. Carly's file opens use origin `carly`; her URL
opens consult link routes.

```lua
declare extern type WindowCx with
	session: SessionCx
	layout: LayoutCx
	canvas: CanvasCx
	docs: DocsCx
	board: BoardCx
	browser: BrowserCx
	db: DbCx
	settings: SettingsCx
	git: GitCx
	notebook: NotebookCx
	actions: ActionsCx
	agents: AgentsCx
	procs: ProcsCx
	screen: ScreenCx
	function run(self, pane: number, text: string): ()
	function open(self, target: string, how: How?, reveal: Reveal?): ()
	function new_block(self, kind: string, args: { string }?, how: How?, reveal: Reveal?): number?
	function command(self, id: string): ()
	function action(self, name: string): ()
	function ask_carly(self, text: string): ()
	function toast(self, level: ToastLevel, text: string, sub: string?): ()
	function copy(self, text: string): ()
end

type ToastLevel = "success" | "info" | "error"
```

Window handlers that act get a `cx`: commands, binds, overrides, routes,
`available` checks, window events, and window timer, process and fetch
callbacks. A `cx` is valid only during the call that received it; using a
stored one later raises an error. Timer, process and fetch callbacks get a
fresh one. A call made through a `cx` while another of its calls is still
running raises `cx is already in use`.

| Member | Behavior | Raises |
| --- | --- | --- |
| `cx.session` | [Session cx](#session-cx) | |
| `cx.sessions` | Session list/current/create/switch/rename/close/lock/unlock | Unknown session or blank name |
| `cx.hosts` | Host list/current/add/switch/trust/disconnect/terminal | Unknown or disconnected host; fingerprint mismatch |
| `cx.board` | [Board cx](#board-cx) (desktop) | Unknown/stale card or lane; invalid metadata; disk errors |
| `cx.browser` | [Browser cx](#browser-cx) | |
| `cx.db` | [Database cx](#database-cx) (desktop) | |
| `cx.settings` | [Settings cx](#settings-cx) | Unknown key/type/enum or invalid keybind |
| `cx.git` | [Git cx](#git-cx) | Desktop |
| `cx.notebook` | [Notebook cx](#notebook-cx) | |
| `cx.actions` | [Actions cx](#actions-cx) | |
| `cx.agents` | [Agent cx](#agent-cx) | |
| `cx.procs` | [Processes cx](#processes-cx), local desktop only | |
| `cx.layout` | [Layout cx](#layout-cx) | |
| `cx.canvas` | [Canvas cx](#canvas-cx) | |
| `cx.docs` | [Documents cx](#documents-cx) (desktop) | |
| `cx:run(pane, text)` | Writes `text` to the pane's program as typed; end with `"\r"` to run a shell command | `no program runs in that pane` |
| `cx:open(target, how?)` | Tern's own open (routes don't run). With `how`, a path (absolute, `file://`, or relative to the focused pane's directory) opens in a file block placed by `how`. Without `how`, or for a non-path, `target` opens as a link clicked in the focused pane: files in a file block, folders in the Files pane, web links in a browser block or the browser, anything else through the system | ``unknown how `<how>` `` |
| `cx:new_block(kind, args?, how?)` | Opens a plugin block of `kind` (`"<plugin>.<id>"`) with `args` on the window's current host, placed by `how` (default `default`), and focuses it; returns its pane, or `nil` (no toast: the caller decides) when no Ready plugin there defines `kind` | ``unknown how `<how>` `` |
| `cx:command(id)` | Runs built-in command `id`; overrides don't run | ``unknown command `<id>` `` |
| `cx:action(name)` | Runs any keymap action, including `plugin.<id>.<command>`, with ordinary window-plugin capabilities for Carly too | Unknown action or plugin handler |
| `cx:ask_carly(text)` | Opens Carly and asks a shown question from any window-plugin context, including callbacks, exports and Carly itself | Empty question |
| `cx:toast(level, text, sub?)` | Shows a toast in this window; `sub` is a second line | ``unknown toast level `<level>` (success, info or error)`` |
| `cx:copy(text)` | Puts `text` on the clipboard | |

`how` values: `default`, `beside`, `split` (same as `beside`), `below`,
`tab`, `replace` (in place of the focused block; `default` when nothing has
focus), `preview`.

Layout and session changes replicate to the other windows of the session;
focus stays this window's own.

### Documents cx

Desktop `cx.docs` works at document level, not editor-widget level. `open(path,
{how?, line?})` returns a pane; `new_note(title, markdown)` creates a session-owned
note through Tern's seeded-note path, with `# title` followed by the Markdown body.

All other methods return awaitables, consumed with `await` in Carly or `:next`
in plugins:

| Method | Result |
| --- | --- |
| `read(path, {from?, lines?})` | Exact text, including unsaved buffer edits; defaults to the whole document |
| `outline(path)` | Parsed Markdown headings `{title, level, line}` (not headings inside code fences) |
| `search(path, query)` | Case-sensitive literal matches `{line, column, text}` |
| `write(path, text)` | Whole replacement; creates a missing file when its parent exists |
| `edit(path, {find, replace, all?})` | Replaces first match, or all nonoverlapping matches |
| `edit(path, {line, insert})` | Inserts exact text before a one-based line; EOF accepts the next line |
| `edit(path, {heading, append})` | Appends at the named section's end, after its subsections |
| `append(path, text)` | Appends exact text at EOF |
| `save(path)` | True once a buffer save is confirmed; closed existing files need no save |

Edits return `{from, to}`, an inclusive one-based changed line span. Heading
titles are rendered/plain titles; absent or duplicate titles fail without edits.
An absent find string also fails. Line numbers and Unicode character columns
start at one. Relative paths resolve against the focused pane's directory.

Open documents use their shared buffer, undo, dirty state and autosave. Closed
files use atomic same-directory writes preserving encoding and permissions.
An edit prepared against a buffer that changed meanwhile fails safely; retry it
against the new text. Operations time out after 30 seconds.

```lua
local pane = cx.docs:open("/tmp/plan.md", {how = "beside"})
await(cx.docs:edit("/tmp/plan.md", {heading = "Next", append = "- Ship\n"}))
return await(cx.docs:outline("/tmp/plan.md"))
```

### Canvas cx

A canvas is the native block kind `tern.canvas`: persistent, replicated
content supplied from window Lua, without a host entry. The package id
`tern` is reserved. Its surface role is `plugin.tern.canvas`.

```lua
declare extern type CanvasCx with
	function open(self, spec: CanvasSpec): (number?, string?)
	function set(self, pane: number, change: CanvasChange): ()
	function get(self, pane: number): CanvasInfo?
	function list(self): { CanvasInfo }
end

type CanvasSpec = {
	title: string, about: string?, view: Node?, md: string?, dock: Node?,
	how: How?, focus: boolean?,
}
type CanvasChange = {
	title: string?, about: string?, view: Node?, md: string?, dock: Node?,
	set: { [string]: Node | false }?,
}
type CanvasInfo = {
	pane: number, owner: string, title: string, about: string,
	view: Node?, dock: Node?,
}
type CanvasAction = {
	pane: number, owner: string, act: string, node: string,
	value: string?, mods: { string }?,
	text: string?, title: string?, about: string?,
}
```

`open` accepts either a `view` tree built with `tern.ui`, or Markdown `md`,
not both. It defaults to `"beside"`, focusing the new pane for plugins and Carly.
A host without canvas support returns
`nil, err`. The view's root is drawn; `dock` is pinned at the bottom.
The view root key `__canvas` is reserved for hidden metadata and raises
synchronously. Other keys are preserved, including a root key `"0"`.
`get` reads this window's replica, returning `nil` for a non-canvas or
one whose state has not arrived. `list` omits view/dock trees.

`set` replaces supplied fields. Its `set` map patches paths below the
view's root: keyed children use their keys, unkeyed children their
zero-based index (`"jobs.build"` or `"0"`). `false` removes a node. A new
key appends below an existing parent; unknown parents raise.
Plugin updates name their own id; Carly may update any canvas. The creator's
plugin id, or `"carly"`, remains stored. Any caller may read canvases.

Limits are 256 KiB per encoded change, 2000 nodes, depth 32, 80 characters
for title and 2000 for `about`. Invalid trees and paths raise before
sending. Input/editor nodes are rejected (canvases take no keys), as are
images (no blob transport). State survives daemon restarts; reloading a
plugin does not reset its canvases.

Only `action` events reach the owner in the clicking window. Register
`tern.on("canvas_action", function(ev, cx) ... end)` in a plugin. The
first truthy return consumes the click; no handler or all falsy returns
toast `Nothing handles “<act>” here`. Toggle and selection are local.
`cx.session:event(pane, {ev = "action", id = node, act = name})` delivers
the same action without a pointer, after the calling handler returns, for
example from a test command.

Carly registers `tern.carly.on_canvas(fn)` in her conversation VM, with
the same payload, a fresh ordinary-capability context and a 50 ms budget.
Use async `:next` continuations, not root-only `await`, inside handlers.
Handlers disappear on conversation reset. An unhandled click becomes a
shown agent turn, quoting the action, node text, title
and persisted `about` as JSON data describing the button's purpose.
Her reply uses normal chips/card behavior and a toast
when the card is closed. iOS has no Carly fallback; web has no window Lua.

```lua
tern.on("canvas_action", function(ev, cx)
	if ev.act ~= "refresh" then return false end
	cx.canvas:set(ev.pane, { md = "Refreshed" })
	return true
end)
```

The complete window-only Canvas Dashboard package in
[the SDK](../index.md#the-sdk) has a palette command that finds an existing
owned canvas after reload and a keyed status update handler. Install it
with:

```sh
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/canvas
```

For headless inspection, `carly last` displays the last tool result or
queued canvas Action prompt; `carly last "<contains>"` also asserts that
the answer includes the given text. The same text is
`state.carly.last_tool.text`.

### Session cx

```lua
declare extern type SessionCx with
	function sessions(self): { SessionInfo }
	function layout(self, tab: number): TabLayout?
	function find_tab(self, spec: string, session: number?): number?
	function find_session(self, spec: string): number?
	function tab_of(self, pane: number): number?
	function pane(self, pane: number | string): PaneInfo?
	function read(self, pane: number | string, opts: ReadOpts?): (BlockRead | string)?
	function surface(self, pane: number | string, opts: SurfaceOpts?): (SurfaceTree | string)?
	function view(self, pane: number | string, opts: SurfaceOpts?): (ViewNode | string)?
	function event(self, pane: number | string, ev: { [string]: any }): ()
	function panes(self): { PaneInfo }
	function tabs(self): { TabInfo }
	function focused(self): number?
	function resolve(self, spec: string): number?
end
```

| Method | Returns |
| --- | --- |
| `panes()` | Every pane in the window's tabs, as [`PaneInfo`](#ternchromestatus) (`cwd` is always a string here) |
| `tabs()` | Every tab of the window, in every session, as [`TabInfo`](#ternchrometab_title) |
| `focused()` | The focused pane's id, or `nil` |
| `resolve(spec)` | The pane `spec` names, or `nil`: `"@focused"`, a pane id, an exact title, a title in any case, then a program name; among several matches, one in the active tab first |

```lua
local pane = cx.session:resolve("nvim")
if pane then
	cx.layout:focus(pane)
end
```

#### Sessions and split trees

`sessions()` returns `{id, name, current, locked, tabs}` for every session.
`find_session` matches an id, then an exact name, then the name ignoring case.
`find_tab` matches a one-based position or title words within the given
session (default current); `tab_of` includes floating blocks. Unknown matches
return `nil`. `TabInfo` additionally includes `session`, `color`, one-based
`position` and focused `pane`; all four participate in chrome cache invalidation.

`layout(tab)` returns `{tab, root, floats, zoomed, focus}` or `nil`.
A `TabTree` leaf is `{pane}`; a split is
`{split = "right"|"down", ratio, [1] = left_or_top, [2] = right_or_bottom}`.
Each float is `{pane, over, corner = "tl"|"tr"|"bl"|"br"}`. These are split
trees, not the TSP trees returned by `surface`.

#### Pane reads and trees

`pane` and `panes` include window-only kind/tab/focused/floating/busy/at_prompt,
current `running = {line, ms}`, `last = {line, status, took_ms}`, exited/error/alert,
browser URL, native path and plugin block kind. Host `tern.pane.list` stays unchanged.
Inspection supplies `program`, `busy`, `at_prompt`, `running`, `last` and `exited`
only for `kind = "terminal" | "agent"`; they are absent for every other kind,
including native and plugin blocks. `tern.chrome.status` keeps its existing
`StatusPaneInfo` payload, including the backing `program` and `busy` for all kinds.

`read` returns `{kind, info, ...}` using each block's actual model: terminal lines
(including TSP surfaces), plugin text, browser URL/title/loading/history, file text
and unsaved edits, git status/commits, SQLite schema/rows/SQL, notebook cells/outputs,
board lanes/cards, processes, profile functions or screen facts. It never runs
browser JavaScript or takes focus. Unloaded states are reported honestly.

`ReadOpts` accepts `as = "table" | "text"` (default table), `lines` (60, max 2000),
`rows` (25, max 500), `max_chars` (8000, max 64000), terminal `scrollback` (true),
and one-based file `from` (default follows the view).

| `kind` | Table fields besides `kind` and `info` |
| --- | --- |
| `terminal`, `agent` | `lines`, `more`, `surface` |
| `plugin` | `title`, `text` (main, dock and layer) |
| `browser` | `url`, `title`, `loading`, `progress`, `error`, `back`, `forward`, `driven` |
| `file` | `path`, `host`, `file_kind`, `mode`, `dirty`, `load`, `first`, `total`, `lines`, `caret`, `selection`; media/hex: `size`, `image`, `hex` |
| `git` | `root`, `ready`, `provisional`, `head`, `upstream`, `operation`, `staged`, `unstaged`, `conflicts`, `selection`, `open`, `commits`, `stashes`, `running` |
| `database` | `path`, `memory`, `phase`, `read_only`, `dirty`, `area`, `schema`, `browse`, `execute`; cached query rows retain SQL NULL and mark unloaded rows |
| `notebook` | `path`, `phase`, `kernel`, `dirty`, `active`, `cells` with source, outputs, tags, index, kind, execution count and state |
| `board` | `path`, `phase`, `view`, `filter`, `hide_done`, `lanes` with title, complete/folded and cards containing text, done, tags, due, subtasks and cursor |
| `procs` | `sampled`, `totals`, `sort`, `descending`, `tree`, `filter`, `rows`, `selected` |
| `profile` | `process`, `pid`, `take`, `show`, `samples`, `functions` with name/self/total, `focus`, `thread`, `query` |
| `screen` | `host`, `display`, `phase`, `failure`, `control`, `frame = {w, h}`; pixels are not text |

Row-shaped lists carry `more` (or `<list>_more`) when capped; where supported,
`first`/`total` describe the selected window. `as = "text"` names the limit in
omission markers. Per-kind fields that are unavailable on this build are absent.
SQL NULL cells and uncached whole-row slots are `tern.json.null`; a loaded row is
always a table, even if all its cells are NULL. Empty arrays stay array-tagged.


`surface` returns `{surface = {id, title?, role?, mode}, main?, dock?, layer?, more?}`.
It chooses the live surface, else the newest retained inline one. Whole omitted
regions contribute to the top-level `more` count.
Nodes use TSP wire form `{id, k, p?, c?, more?}`; `more` counts omitted descendants.
`SurfaceOpts` accepts `as`, `root` (node id), `nodes` (500, max 5000), `depth`
(default all, max 64), and `max_chars`. `view` takes the same caps and returns
Tern's accessibility subtree `{role, name?, value?, states?, children?, more?}`
without ids or bounds; hidden or unmounted blocks return `nil`.
`event` sends a TSP event to the pane's program for plugins and Carly. A
canvas has no program: there it takes only `action` events (anything else
raises) and delivers each as a click on node `id`, after the calling handler
returns ([Canvas cx](#canvas-cx)).

```lua
return cx.session:read("@focused", {as = "text", rows = 10})
```

### Screen cx

`cx.screen:displays()` returns an awaitable list of local displays with `id`,
`name`, `width`, `height`, `scale` and `primary`. Share one with
`cx.screen:share(id, {how = "view"})`; `"control"` forwards keyboard/pointer
input, and nil or `"main"` selects the primary display. The returned pane id
works with `status(pane)` (phase, host, display, control, frame, failure) and
`stop(pane)` (closes sharing). Both accept session resolve specs too.

### Processes cx

`cx.procs` always addresses the local desktop machine, not the focused remote
host. `list(options?)`, `find(name_or_pid)` and `children(pid)` return awaitables
over the same background sampler as Carly's `processes`/`inspect processes`.
Carly uses `await(...)`; plugins use `:next(function(result, err, cx) ... end)`.

`list` returns `{local, sample, total, more, processes}`. Options are `sort`
(`name`, `pid`, `user`, `cpu`, `memory`, `gpu`, `threads`, `disk`), `descending`,
`name`, `user`, `cwd`, `limit` (default 100, 1–5000), and `tree` (default false).
Text filters combine with AND and match case-insensitive substrings. Names,
PIDs and users default ascending; usage columns descend. Tree output is a
preorder list with `depth` and `context` (a nonmatching ancestor kept for context).
Details include command, executable, parent, cwd, user, state and usage; cwd and
other unknown OS details are nil. `find` returns the busiest name match or exact
PID, nil if absent. `children` returns immediate children, at most 5000.
Ports and port filtering are omitted: the sampler does not collect sockets,
and mapping sockets to owners requires a separate machine-wide OS scan.

`signal(pid, signal)` accepts `terminate`, `kill`, `interrupt`, `hangup`, `stop`
and `continue`; success returns `{pid, signal, signaled=true}`. It signals one
positive local PID directly; errors raise the shared machine-readable
`{kind, message, pid, signal}` envelope.

`open()` returns the pane id of a focused Processes block beside the current
pane (or a new tab when empty). `profile(pid, {seconds=20})` opens a profile block
and returns an awaitable of `{pane, pid, process, samples, functions, ...}` once
sampling and symbolication finish. Duration is 1–3600 seconds. The top 25
functions include `name`, `self` and `total` sample counts; OS profiler failures
reject the awaitable. A closed profile block also rejects it.

```lua
local rows = await(cx.procs:list({name = "rust", sort = "memory", tree = true}))
local p = await(cx.procs:find("rustc"))
if p then
	local report = await(cx.procs:profile(p.pid, {seconds = 2}))
	print(report.pane, report.functions)
end
```

## Actions cx

`cx.actions:list(query?)` returns builtin and plugin palette actions with `id`,
`label`, `group`, `keys` (effective spelled chords), `available`, and optional
`plugin` id. Unavailable commands remain discoverable. Query words match the id,
label and group. `describe(id)` returns one exact id or errors. `keys()` maps
effective chords to action-id arrays, preserving focus-resolution priority.

`cx.actions:run(id_or_exact_label)` returns the same success message as Carly's
`actions` tool; unknown and ambiguous labels error. `cx:action(name)` is the
shortcut to the same dispatch. Closing is noninteractive, like Carly's tool.

### Notebook cx

`cx.notebook` uses the same loaded cells, undo history and Python kernel as the
notebook block. Notebook ids are pane ids. Cell ids are stable numeric keys from
`cells`, not row indices; reloading a notebook replaces those keys.

| Method | Result |
| --- | --- |
| `open(path)` | Opens beside the focused pane and returns its notebook pane id |
| `cells(nb)` | All cells in document order, including full source and outputs |
| `run(nb, {cell = id})` or `run(nb, {all = true})` | `Awaitable<{NotebookCell}>`, output snapshots in run order |
| `add(nb, {kind, source, after?})` | New cell id; undoable; default append, `after = 0` prepends |
| `edit(nb, cell, source)` | Undoable source replacement, preserving outputs |
| `kernel_status(nb)` | `NotebookKernel`, current interpreter and execution/input/failure details |
| `kernel_restart(nb)` | `Awaitable<NotebookKernel>`, new kernel idle after an unconfirmed restart |

Cell kinds are `"code"`, `"markdown"` and `"raw"`. Each `NotebookCell` contains
`id`, `nbformat_id`, `kind`, `source`, `count`, `state` (`idle`, `queued`, `running`)
and `outputs`. Outputs retain stream text, MIME-keyed `data` and `metadata`,
execution result `count`, display ids and complete error tracebacks. Python
exceptions are ordinary error outputs, not await failures. Nullable returned
values use `tern.json.null`.

Kernel status includes `status` (`not_started`, `starting`, `idle`, `busy`,
`dead`), `label`, `python`, `version`, `implementation`, `env`, `pid`, `waiting`,
`running`, `input = {prompt, password}` and `dead` (failure message).
Execution and interpreter startup run off the UI thread. Awaits have no
execution timeout; interactive input uses the notebook UI. Already queued or
running target cells cannot be run or replaced through this API. Kernel loss,
notebook closure or replacement/removal of awaited cells fails the await;
resetting the Lua VM cancels the await without stopping the user's kernel.

```lua
local nb = cx.notebook:open("/tmp/analysis.ipynb")
local id = cx.notebook:add(nb, {kind = "code", source = "print(6 * 7)"})
cx.notebook:run(nb, {cell = id}):next(function(cells, err, cx)
	if err then error(err) end
	cx:toast("success", cells[1].outputs[1].text)
end)
```

Carly uses `await(cx.notebook:run(nb, {all = true}))` instead of `:next`.
Operations on a loading or failed notebook raise the real loading/file error.

### Agent cx

`cx.agents:list()` returns agents across every session: agent blocks, and shells
running omp (typed at the prompt; their `command` is `tern.json.null`), both of
`kind = "agent"`: `{pane, command, model, cwd, state, last_message}`. Unknown
metadata is `tern.json.null`. Targets accept pane ids or resolve specs such as
`"@focused"` and an agent title.

- `start({prompt, cwd, command?, how?}) -> pane`: opens like New agent block;
  omitted command and placement use settings. `how` is `"split"`, `"tab"` or
  `"replace_if_alone"`. The window submits the prompt once input is ready, even
  after the launching VM resets.
- `ask(agent, text)`: pastes one prompt and presses Enter; requires ready input.
- Desktop `wait(agent, {timeout?}) -> Awaitable<string?>`: waits until idle, returning
  the last assistant text. Timeout is milliseconds (default 30000). Gone/exited
  agents and timeout reject. Queued/submitted input is not prematurely idle.
- `transcript(agent, {last?})`: chronological `{role, text, tools}` from the omp
  TSP chat. Roles are `"user"`/`"assistant"`; thinking/chrome are excluded, tool
  call metadata/output is retained. Default last=50, max=1000; zero is empty.
  Non-omp agents have no structured transcript.
- `interrupt(agent)`: Ctrl-C, preserving the block.
- `stop(agent)`: closes the block and ends its program without a confirmation.

Working/idle comes from progress OSC 9;4; paused progress or an ask overlay is
`waiting_input`. Plugins use `:next(function(message, err, cx) ... end)` for waits;
Carly uses `await(...)`:

```lua
local pane = cx.agents:start({prompt = "Explain the failing tests", cwd = "/work/app"})
local answer = await(cx.agents:wait(pane, {timeout = 120000}))
return {answer = answer, messages = cx.agents:transcript(pane, {last = 4})}
```

### Git cx

`cx.git` operates on local repositories through the same configured engine as
git blocks. A target is a descriptor returned by `repo`, a path, a local pane id,
or a `cx.session:resolve`-style spec such as `"@focused"`. All methods return
Awaitables: Carly uses `await(...)`; plugins use `:next(function(result, err, cx)
... end)`. Failures reject with git's error; resetting a VM drops late answers.

| Method | Result / meaning |
| --- | --- |
| `repo(target)` | Root, branch, HEAD, upstream, ahead/behind and in-progress operation |
| `status(repo)` | Staged, unstaged and conflict file lists, with rename sources and line counts |
| `log(repo, {limit?, path?})` | Git graph history across refs; default 50, maximum 100000; path follows HEAD file renames |
| `diff(repo, {path?, staged?, rev?})` | Unified text; default unstaged, staged index, or one revision's commit patch |
| `stage(repo, paths)` / `unstage(repo, paths)` | Change only the index; literal repo-relative paths, empty list changes nothing |
| `commit(repo, message, {amend?})` | Commit the index with a full message, optionally amending HEAD |
| `branches(repo)` | Local and remote branch targets, tracking and current state |
| `checkout(repo, name, {detached?})` | Switch branch, create local tracking branch, or detach at a revision |
| `create_branch(repo, name, {at?})` | Create and check out a branch at HEAD or the specified revision |
| `stash_push(repo, {message?})` | Stash tracked and untracked changes |
| `stash_pop(repo, {index?})` | Apply and drop a stash, newest first with zero-based index (default 0) |
| `open(repo, {how?})` | Git pane id; native placement vocabulary, default reuses a block in the tab |

`diff` cannot combine `staged = true` and `rev`. Mutations share the git block's
serialized worker, undo journal and refresh of every open block on the root.

```lua
local repo = await(cx.git:repo("@focused"))
local changes = await(cx.git:status(repo))
await(cx.git:stage(repo, {"src/main.rs"}))
local patch = await(cx.git:diff(repo, {staged = true}))
local pane = await(cx.git:open(repo, {how = "tab"}))
```

### Settings cx

Every preference `settings.json` can hold is available through `cx.settings`,
defaults included (the file keeps only the changed ones).
Root field names are canonical; `terminal.font_size` aliases `font_size`.
Dotted paths name nested fields (`carly.model`, `sqlite.drop.quoted`);
`get` can also read entire subtrees.

| Method | Result |
| --- | --- |
| `get(key)` | Current value or subtree |
| `set(key, value)` | Effective value after the normal clamp and save |
| `set_many(table)` | Atomically applies dotted-key or nested patches; returns all leaf values |
| `list(prefix?)` | Dotted leaf keys mapped to current values |
| `describe(key)` | `{type, enum, range, default, nullable, doc}` derived from Settings |
| `themes()` | Installed theme names |
| `keybinds()` | User keybind overrides, not the effective keymap |
| `bind(chord, action_or_actions)` | Binds an action or priority-ordered action array |
| `unbind(chord)` | Writes an empty override, leaving the keys to the program |

Unknown keys, invalid types/enums and overlapping paths fail without changing
preferences. Nested object patches merge; `keybinds` replaces the entire override
map. Numeric values within their storage type clamp through the existing settings
clamp. Null/nil clears optional preferences; `get` returns nil for them.
`list` retains unset keys as `tern.json.null`. Headless sessions remain ephemeral.
Remove a chord from a replacement `keybinds` map to restore its default binding;
`cx.actions:keys()` shows the effective bindings.

```lua
cx.settings:set_many({["carly.model"] = "@smol", notebook = {start_on_open = true}})
cx.settings:bind("cmd+shift+h", "new_tab")
local font = cx.settings:describe("terminal.font_size")
```

## Sessions and hosts cx

`cx.sessions:list()` returns every named session (`id`, `name`, `host`,
`current`, `locked`, `note`, tab count). `:current()` returns the shown one.
`:create({name?, cwd?})` creates and shows a session on the current host,
starting its first tab in `cwd`. `:switch(spec?)`, `:rename(spec, name)`,
`:close(spec?)`, `:lock(spec?)` and `:unlock(spec?)` accept an exact name or id;
nil and `"@current"` select the shown session. Blank names error.
Close ends programs without interactive confirmation or lock guards; closing
the final session leaves it open and empty.

`cx.hosts:list()` and `:current()` return machines with identity chains,
connection state and detail, measured `rtt_ms` (null when unavailable), and
session/pane ids. Ids pass unchanged to the session and layout namespaces.
Host specs accept a slot, case-insensitive name, address, `"local"` or `"@current"`.

Desktop `:add(address)` returns `Awaitable<ManagedHost>`; Carly uses `await`,
plugins `:next(function(host, err, cx) ... end)`. It resolves when connected
and fails if the connection fails or the host disconnects. First contact
still uses Tern's ordinary key verification: inspect `detail.fingerprint`,
independently verify it, then call `:trust(host, fingerprint)` or use the
host dialog. A mismatching fingerprint errors rather than accepting a key.

`:switch(host)` shows the connected host's last session. `:terminal(host,
{cwd?, command?})` opens and focuses a shell tab there, returning its pane id.
`:disconnect(host)` disconnects and forgets a remote machine; its programs
keep running there. The local host cannot be disconnected.

```lua
local session = cx.sessions:create({name = "Build", cwd = "/tmp"})
local pane = cx.hosts:terminal("local", {cwd = "/tmp", command = "printf hello"})
cx.sessions:switch(session.id)
```

### Board cx

Desktop `cx.board` edits Markdown task boards at the card/lane level.
`open(path, {how = "beside"})` returns a board pane; all other methods return
awaitables (Carly: `await(...)`; plugins: `:next(function(result, err, cx) ... end)`).
Board arguments accept a local path or board pane id; relative paths use the
focused local pane's cwd. `how` also accepts `default`, `below`, `tab`, `pip`,
and `preview`.

| Method | Behavior |
| --- | --- |
| `boards()` | Open boards and task/Kanban Markdown files in local pane cwds and checkout roots |
| `read(board, {rows?, from?, max_chars?})` | Common block-reader lanes/cards; default 25 rows, maximum 500; `from` is the first one-based lane; `more` reports omitted data |
| `add(board, {lane, text, tags?, due?, subtasks?})` | Adds a card; returns its opaque id; subtasks are strings or `{text, done?}` |
| `move(card, lane, {position?})` | Moves by card id to lane title/id; one-based position excluding the card, default append |
| `check(card, done)` | Checks/reopens using the board engine's done-lane movement |
| `edit(card, {text?, tags?, due?})` | Replaces only supplied fields; `tags={}`/`due=false` clear those fields; keeps notes/subtasks |
| `remove(card)` | Removes the card with its notes and subtasks |
| `add_lane(board, {title, position?})` | Inserts a lane, default append; returns its opaque id |
| `rename_lane(board, lane, title)` | Renames a lane by exact title or id |
| `remove_lane(board, lane)` | Removes the lane and all its cards |

Tags omit `#`; dates use `YYYY-MM-DD`. Cards/lanes use the `id` from `read`
(or insertion), not row positions. Their ids stay stable across model edits
and Undo, but external file reloads and reopening invalidate them; re-read
afterward. Duplicate lane titles require ids. Moving into Done checks a card;
moving out reopens it. Open boards share the live model, Undo, rendering and
autosave. Closed-file operations retain model identity while disk is unchanged
and use the same engine plus atomic writes off the window thread. Autosave
failures reject while retaining the open board's in-memory edit and Undo.

```lua
local pane = cx.board:open("/repo/TODO.md")
local card = await(cx.board:add(pane, {lane = "Doing", text = "Write docs",
	tags = {"docs"}, subtasks = {"Draft", "Review"}}))
await(cx.board:check(card, true))
local board = await(cx.board:read(pane, {rows = 500}))
```

### Database cx

Desktop `cx.db` opens existing local SQLite databases without creating panes.
Every operation runs on the engine's ordered worker and returns an awaitable;
plugins use `:next(function(result, err, cx) ... end)`, Carly uses `await`.

| Method | Awaited result |
| --- | --- |
| `open(path, {read_only = true}?)` | Opaque numeric connection id, owned by this Lua VM |
| `tables(db)` | Main database's user table and view names, sorted |
| `schema(db, table)` | Stored CREATE SQL; unknown names fail |
| `query(db, sql, {limit = 1000}?)` | `{columns = {string}, rows = {{DbCell}}}` |
| `exec(db, sql)` | `tern.json.null` on success |

Relative paths resolve against the focused pane's cwd, or home without a pane.
Connections live until their Lua VM is dropped. The default uses SQLite's
actual read-only open flags. Only `open(path, {read_only = false})` permits
`exec`; writes autocommit unless the SQL explicitly starts a transaction.
`query` requires one row-producing read-only statement even on writable handles.
It does not rewrite the SQL. `limit` caps returned rows; zero returns only columns.

Rows preserve positions: SQL NULL is `tern.json.null`; text and finite numeric
values are ordinary strings/numbers. Blobs are `{blob = {byte, ...}}`, integers
outside Luau's exact numeric range are `{integer = decimal_string}`, and
nonfinite reals are `{real = "inf" | "-inf"}`. Empty arrays stay arrays.
SQLite failures fail the awaitable; no permission gate separates plugins and Carly.

```lua
cx.db:open("/tmp/catalog.sqlite"):next(function(db, err, cx)
	if err then error(err) end
	cx.db:query(db, "SELECT * FROM products", {limit = 20}):next(function(result, err, cx)
		if err then error(err) end
		cx:toast("success", tostring(#result.rows) .. " rows")
	end)
end)
```

### Browser cx

`cx.browser:call(op) -> Awaitable<BrowserResult>` runs the `tern browser` op
vocabulary. Plugins use `:next(function(result, err, cx) ... end)`; Carly uses
`await`. Answers are `{ok = answer}` or `{error = {kind, message}}`.
Resetting the conversation drops outstanding Carly answers.

`snapshot` takes `block`, optional `root` (ref or CSS selector), `depth`, `nodes`
(400, max 3000), `mode = "outline" | "text"`, and `format = "tree" | "text"`.
It returns URL/title, tree or text, omitted nodes and iframe metadata. Interactive
elements get stable isolated-world refs; password values are masked and hidden
nodes omitted. It never arms Tern's driven-page/dialog policy, but evaluating a
native page installs the platform's driver delegate.

`act` takes `block`, `ref`, `action = "click" | "fill" | "press" | "select" |
"check" | "uncheck" | "hover" | "scroll"`, optional `text`, `keys` (chord string or
array), `dx` and `dy`. It uses trusted input where possible; stale refs fail with
`not_found`. Carly can use every browser operation with ordinary window-plugin
capabilities.
Headless snapshots fail with `failed: a headless session shows no pages`; sync
`session:read` still supplies URL/title.

```lua
local page = await(cx.browser:call({op = "snapshot", block = pane}))
if page.error then error(page.error.message) end
return page.ok
```

### Layout cx

```lua
declare extern type LayoutCx with
	function new_tab(self, launch: Launch?, reveal: Reveal?): number?
	function split(self, target: number, dir: Dir, launch: Launch?, reveal: Reveal?): number?
	function focus(self, pane: number): ()
	function close(self, pane: number): ()
	function move(self, pane: number, target: number, dir: Dir | "swap", reveal: Reveal?): boolean
	function resize(self, pane: number, dir: Dir, cells: number): boolean
	function tab(self, spec: TabSpec, reveal: Reveal?): (number?, string?)
	function move_to_tab(self, pane: number, tab: number, reveal: Reveal?): (boolean, string?)
	function move_to_new_tab(self, pane: number, session: number?, reveal: Reveal?): (number?, string?)
	function float(self, pane: number, over: number?, corner: Corner?, reveal: Reveal?): (boolean, string?)
	function dock(self, pane: number, target: number?, dir: Dir?, reveal: Reveal?): (boolean, string?)
	function even(self, tab: number): ()
	function name_tab(self, tab: number, name: string?): ()
	function color_tab(self, tab: number, color: TabColor?): ()
	function order_tab(self, tab: number, position: number): ()
	function rename_session(self, session: number, name: string): (boolean, string?)
	function snapshot(self): LayoutSnapshot
	function restore(self, snap: LayoutSnapshot): (boolean, string?)
	function arrange(self, spec: Arrange): ({ TabArrangement }?, string?)
end

type Dir = "right" | "down" | "left" | "up"
type Corner = "tl" | "tr" | "bl" | "br"
type TabColor = "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink"
type Reveal = { focus: boolean? }
```

| Method | Behavior | Returns |
| --- | --- | --- |
| `new_tab(launch?)` | Opens a tab in the current session running `launch`, makes it active | The new pane, or `nil` when `launch.block` names a type the host lacks |
| `split(target, dir, launch?)` | Splits pane `target` with a new pane on its `dir` side, on `target`'s host, in `target`'s directory unless `launch.cwd` is set; the new pane takes its tab's focus | The new pane, or `nil` when `target` is in no tab or the block type is missing |
| `focus(pane)` | Focuses the pane (in this window) | nothing |
| `close(pane)` | Raw session close for plugins and Carly | nothing |
| `move(pane, target, dir, reveal?)` | Moves pane to target's edge, or swaps for `"swap"`; reveals by default for plugins and Carly | Boolean |
| `resize(pane, dir, cells)` | Moves the pane's nearest divider toward dir by about cells; negative moves it the other way | Boolean |
| `tab(spec)` | Builds a workspace tab and names it | The tab id (`nil` when its first pane can't start), then an error string when any pane couldn't start ([Workspaces](#workspaces)) |

`split`, `move` and `resize` raise ``unknown direction `<dir>` (right, down,
left or up)``. `move` refuses (returns `false`) to move a pane to another
host.

`Reveal` is `{focus = boolean}`. Plugins and Carly share the same defaults:
creation reveals as before, `move` focuses the moved block, and a default
`split` hands its target tab's focus to the new block without switching tabs.
Explicit true reveals the result; false preserves shown focus.

`move_to_tab` puts a block beside the destination tab's focused leaf;
`move_to_new_tab` makes a final tab in the block's own or specified session.
Cross-host moves refuse. `float` defaults to the leaf taking over the old
area and its nearest corner; an existing float may be re-placed. `dock`
defaults to the original split when still valid, else beside the owner.

`even` equalizes splits by tab id. `name_tab` clears the explicit title for
nil/blank; `color_tab` clears for nil; `order_tab` uses a one-based session
position. `rename_session` refuses a blank name or unknown session.
`snapshot` captures trees, floats, names, colors and order, not programs.
`restore` returns `false, why` if blocks opened/closed or a saved session
disappeared; otherwise restores without stealing shown focus.

Carly's first mutation in a turn captures one snapshot. A changed arrangement
offers one **Carly rearranged your workspace** toast with **Undo** at the
turn boundary. Undo refuses safely if its blocks no longer match. Restored tab
titles and the selected fill appear immediately, without new-tab entrance motion.

#### One-call grouping

`arrange` regroups a session atomically:

```lua
local tabs, err = cx.layout:arrange({
	tabs = {
		{name = "Build", color = "teal", blocks = {"cargo"}, split = "rows"},
		{tab = "2", name = "Logs", blocks = {}}, -- rename-only
	},
	rest = "keep",
})
```

`session` may be an id or name (default current). `tab` may be an id or a
`find_tab` spec; `blocks` accept ids or `resolve` specs such as `"@focused"`.
An absent tab reuses the tab holding most of the group's blocks (ties:
first), else creates one. Empty blocks move nothing into the tab, allowing
rename-only calls. Groups lead the tab list in the supplied order; untouched
tabs keep their relative order. Omitted `split` preserves the target tree,
appending incoming blocks; `columns`, `rows` or balanced `grid` rebuild it.
Unmentioned blocks stay put (`rest = "keep"`) or collect in one trailing
**Other** tab (`"last"`). Empty tabs close without ending programs.
Validation rejects unknown, duplicate or cross-host blocks before changing
anything. The result contains `{id, position, name, blocks}` for every
resulting session tab. Focus stays on the same block and follows its tab.

The direct Carly `arrange` tool takes the equivalent JSON and answers with
the same capped window outline as each request's context, including split
trees. Carly uses that outline for orientation and the shared Lua APIs for
focus, tab switching, file/URL opening and terminal creation.

### `Launch`

```lua
type Launch = {
	cwd: string?,
	command: string?,
	block: string?,
	args: { string }?,
}
```

| Field | Meaning |
| --- | --- |
| `cwd` | Working directory (default: where a new tab or split starts) |
| `command` | A command line the pane's login shell runs instead of an interactive shell |
| `block` | A plugin block kind `"<plugin>.<id>"`; the pane runs that block instead (and `command` is unused) |
| `args` | The block's launch arguments |

No `launch` (or an empty one) runs a shell.

Carly's `new_tab`, `split` and workspace `tab` launches use the anchor block's
machine and directory, ignoring the new-tab Home preference; `split` anchors to
its target. `~` and `~/…` expand on that machine. An SSH-hop directory reported
by OSC 7 must belong to an attached host, otherwise the launch fails before
changing the window. When the directory's host differs from the split target's,
Carly opens a tab on that host instead of reusing the remote path locally.
Ordinary plugin launch defaults are unchanged.

### Workspaces

```lua
type TabSpec = {
	cwd: string?,
	name: string?,
	split: Dir?,
	ratio: number?,
	launch: Launch?,
	[number]: TabSpec,
}
```

`cx.layout:tab(spec)` builds a tab from a tree. A node with `[1]` and `[2]`
is a split between them along `split` (default `"right"`), with `ratio`
setting the first side's share (default half); a node without
them is a leaf that runs its `launch`. `cwd` is inherited downward until a
node names its own, and a leaf's `launch.cwd` wins over both. `name` on the
root names the tab, whether or not it is the active one when the build
ends. A `launch` on a node that has children is ignored.

The leftmost leaf opens the tab; the tree is then filled by splitting, `[1]`
before `[2]` at each level. `tab` returns two values: the tab's id, and an
error string when a pane couldn't start (`nil` when all did).

- When the leftmost leaf can't start (its `launch.block` names a kind no
  Ready plugin on the host defines), no tab opens: ``nil, "could not start
  block `<kind>`"``.
- When a split's new side can't start, that side and everything under it
  are left out, the rest of the tree is still built and the tab is named:
  ``<id>, "could not start block `<kind>`"``. Several are listed,
  comma-separated; a `command` leaf shows as `` `<command>` ``.

Nothing is toasted for you; report the error the way your plugin should:

```lua
local tab, err = cx.layout:tab(spec)
if err then
	cx:toast("error", if tab then "Workspace opened incomplete" else "Workspace not opened", err)
end
```

```lua
tern.on("window_start", function(cx)
	cx.layout:tab({
		name = "stencil",
		cwd = (tern.getenv("HOME") or "") .. "/work/stencil",
		split = "right",
		{ launch = { command = "nvim" } },
		{
			split = "down",
			{ launch = { command = "cargo watch -x check" } },
			{},
		},
	})
end)
```

## Related pages

- [Commands, Keys, and Overrides](../guides/commands.md),
  [Routing Opens and Links](../guides/routing.md),
  [Chrome and Styling](../guides/chrome.md), [Layout and Workspaces](../guides/layout.md).
- [Built-in Actions](actions.md) for command ids and action names.
- [Events](events.md) for window event payloads and ordering.
