# Host API

The host context runs `host.luau` on one worker thread per plugin, where the
machine's panes run: inside the session daemon, or inside a window when no
daemon serves its panes. It owns plugin blocks, command lenses, host events
with the spawn filter, and writing to panes. Every call into it has a 2 s
budget. See [Architecture](../concepts/architecture.md) for where the worker
lives and [Lifecycle and Reload](../concepts/lifecycle.md) for what a reload
does to running blocks and lenses.

Requests a handler makes through a `cx` (renders, saves, exits, frames,
blobs, toasts, opens, copies) and through `tern.pane.write` are queued and
applied after the handler returns, so no handler runs inside another.

## `tern.block.define`

```lua
tern.block.define: (id: string, def: BlockDef<any>) -> ()
```

Implements block type `id`, which `plugin.toml` must declare in a
`[[blocks]]` table. The block's kind is `<plugin>.<id>`; its surface role is
`plugin.<plugin>.<id>`.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | A `[[blocks]]` `id` of this plugin |
| `def` | `BlockDef<S>` | The handlers below |

Raises:

- `tern.block.define: block "<id>" is not declared in plugin.toml`;
- ``tern.block.define: <id>: `init` must be a function`` (and the same for
  `view`).

Calling it again with the same `id` replaces the definition for blocks that
start afterwards. A block declared in the manifest and still undefined when
the entry finishes fails the plugin: `block <id> is declared in plugin.toml
but not defined with tern.block.define`.

### `BlockDef`

```lua
type BlockDef<S> = {
	init: (cx: BlockCx, args: { string }, saved: any) -> S,
	view: (state: S, cx: BlockCx) -> BlockView,
	title: ((state: S) -> string?)?,
	key: ((state: S, key: Key, cx: BlockCx) -> boolean?)?,
	event: ((state: S, ev: UiEvent, cx: BlockCx) -> ())?,
	resize: ((state: S, cols: number, rows: number, cx: BlockCx) -> ())?,
	save: ((state: S) -> any)?,
}

type BlockView = {
	main: Node?,
	dock: Node?,
	layer: Node?,
}
```

| Field | Required | Called | Hook name |
| --- | --- | --- | --- |
| `init(cx, args, saved)` | yes | When the block starts, after a reload, and after a daemon restart | `<id>.init` |
| `view(state, cx)` | yes | After every handler and every `cx:render()` | `<id>.view` |
| `title(state)` | no | After every `view` | `<id>.title` |
| `key(state, key, cx)` | no | On each key press and paste; returns exactly `false` for a key that changed nothing | `<id>.key` |
| `event(state, ev, cx)` | no | On each user event from the view's nodes | `<id>.event` |
| `resize(state, cols, rows, cx)` | no | When the pane's size in cells changes (without it, the block still re-renders) | `<id>.resize` |
| `save(state)` | no | After every handler (not after a `key` that returned `false`), and on `cx:save()` | `<id>.save` |

`init` receives:

- `args`: the launch arguments as an array of strings (from a route
  decision, `cx:new_block`, a `launch` table, or "Open with" a file, which
  passes the path);
- `saved`: the last value `save` returned, decoded from JSON, or `nil` for a
  new block.

`init`'s return value is the block's state, passed to every other handler.
Mutate it in place; handlers other than `init` return nothing that is kept
(`key`'s return only decides whether a render follows).

An `init` that raises ends the block: its error text (with traceback) is
printed in the pane, the pane exits with status 1, and the failure is
toasted.

**After every handler** (`init`, `key` unless it returned exactly `false`,
`event`, `resize`, and a `cx:render()`), the worker:

1. calls `view` and diffs the result against the last view it sent;
2. sends one frame of changes when there are any;
3. calls `title` and sends the title when it returned a string different
   from the last one sent (`nil` keeps the current title; before any title,
   the pane shows the manifest `title`);
4. calls `save` and stores the result with the pane only when its JSON
   differs from the last stored value.

A handler that raises is reported and loses only that call: the render and
save after it still run.

A resize of a block without a `resize` handler runs steps 1 to 3 (`cx.cols`
and `cx.rows` changed, so `view` may lay out differently); nothing changed
the state, so `save` doesn't run. With a handler, the handler runs, then all
four steps.

`key` returns exactly `false` when the key changed nothing: the worker
skips the render and the save. Any other return (`true`, `nil`, no return)
renders and saves. A `key` that changes the state and returns `false` leaves
the view stale until the next render, so return `false` only for keys the
block doesn't use. The return doesn't route keys: they reach the block the
way they reach any pane's program, the window's keymap takes the keys it
binds first, and every other key goes to the block whether `key` handles it
or not.

### View model

`view` returns the whole tree of each region every time: `main` (the block's
area), `dock` (a strip under it) and `layer` (above it). Returning `nil`, or
leaving a region out, shows nothing there.

A region's root node is a container, not a drawn node: only its `role` prop
(set as `data-role` on the region element) and its children are shown. Give
each region a `tern.ui.col` or `tern.ui.row` root; `main = tern.ui.text(…)`
shows nothing, `main = tern.ui.col({ tern.ui.text(…) })` shows the text.

The worker assigns every node an id: the region name at the top, then
`<parent id>.<key>` where `key` is the node's `p.key` (a string or number) or
else its index among its siblings (0-based). Keyed nodes keep their id, and
Tern keeps their view state (scroll position, focus, collapsed state) across
reorders. Unkeyed nodes are matched by position.

| Change between two views | Ops sent |
| --- | --- |
| Same id and kind, props differ | `set` of the changed props; removed props as `null` |
| Text kind (`text`, `md`, `code`, `ansi`, `math`, `editor`, `input`, `shimmer`) whose `text` grew by a suffix | `text … append` with the new suffix |
| Text kind whose `text` changed otherwise | `text … replace` |
| Same id, different kind | `del` then `add` |
| Child gone, added, or reordered | `del`, `add` before its next sibling, moved by id |

Frames larger than 64 KiB are split into chunks.

A view that cannot be read is reported as a failure of `<id>.view` and the
last view stays on screen:

| Problem | Message |
| --- | --- |
| Not a table or `nil` | `view: expected {main?, dock?, layer?}, got …` |
| A key other than the three regions | `view: unknown region "<k>" (main, dock or layer)` |
| A node that isn't a table | `<id>: a node must be a table, got …` |
| A node without a string `k` | ``<id>: a node needs a string `k` `` |
| `p` not a table | ``<id>: `p` must be a table, got …`` |
| `c` not a list | ``<id>: `c` must be a list, got …`` |
| Two siblings with the same key | `<id>: duplicate child key "<key>"` |

Build nodes with [`tern.ui`](ui.md). See [Building Views](../guides/views.md).

### `Key`

```lua
type Key = {
	name: string,
	text: string?,
	ctrl: boolean,
	alt: boolean,
	shift: boolean,
	meta: boolean,
}
```

| Field | Meaning |
| --- | --- |
| `name` | The key: a lowercase character (`"a"`, `"+"`, `"é"`), `"space"`, or a named key below |
| `text` | What the key types, when it types something (`"A"` for Shift+A, `" "` for Space); absent for named keys and most chords |
| `ctrl`, `alt`, `shift`, `meta` | Modifiers held; `meta` is Cmd on macOS and Super elsewhere |

Named keys: `enter`, `tab`, `backspace`, `escape`, `space`, `up`, `down`,
`left`, `right`, `home`, `end`, `begin`, `page_up`, `page_down`, `insert`,
`delete`, `menu`, `f1` … `f35`, `caps_lock`, `scroll_lock`, `num_lock`,
`print_screen`, `pause`. Keypad keys report the character they stand for.

A paste arrives as one key with `name = "paste"`, `text` set to the pasted
text, and no modifiers. Key releases, lone modifier presses and media keys
are not delivered.

### `UiEvent`

```lua
type UiEvent = {
	ev: string,
	[string]: any,
}
```

User events from the block's nodes. Only these `ev` values reach `event`;
the rest of the surface protocol traffic (acks, resizes, theme and visibility
changes) does not:

| `ev` | Sent when | Fields |
| --- | --- | --- |
| `action` | A pointer action with a custom name runs (`p.actions = { click = "inc" }`) | `id`, `act`, `mods` |
| `select` | A node's `select` action runs | `id`, `item` |
| `activate` | A node's `activate` action runs (double-click, Enter) | `id`, `item` |
| `toggle` | A collapsible node is opened or closed (Tern flips it locally) | `id`, `key`, `collapsed` |
| `focus` | A click asks for the keys in an `editor` or `input` | `id` |
| `edit` | Native editing in an editor | `id`, `from`, `to`, `text`, `cursor`, `len` |
| `undo` | ⌃Z under native editing | `id` |

`id` is the node id the worker assigned (`main.0.2`, or `main.rows` for a
child keyed `rows`; see [View model](#view-model)). The payloads are the
surface protocol's ([Input and Events](../protocol/input.md#events)). Tern sends
`edit` only to programs whose hello lists the `edit` feature and `undo` only
to those listing `undo`; a plugin block's hello lists no features, so these
two do not arrive in practice.

### Example

```lua
tern.block.define("counter", {
	init = function(_cx, args, saved)
		return { count = if saved then saved.count else tonumber(args[1]) or 0 }
	end,
	title = function(state)
		return "Counter " .. state.count
	end,
	view = function(state, _cx)
		local plus = tern.ui.badge("+", "accent")
		local p: { [string]: any } = plus.p or {}
		p.actions = { click = "inc" }
		plus.p = p
		return { main = tern.ui.col({
			tern.ui.text({ tern.ui.span("Count: ", "muted"), tern.ui.span(tostring(state.count), "strong") }),
			plus,
		}) }
	end,
	key = function(state, key, _cx)
		if key.text == "+" then
			state.count += 1
		end
		return nil
	end,
	event = function(state, ev, _cx)
		if ev.ev == "action" and ev.act == "inc" then
			state.count += 1
		end
	end,
	save = function(state)
		return { count = state.count }
	end,
})
```

```toml
[[blocks]]
id = "counter"
title = "Counter"
```

## Block cx

```lua
declare extern type BlockCx extends EffectCx with
	pane: number
	cwd: string?
	cols: number
	rows: number
	function render(self): ()
	function save(self): ()
	function exit(self, code: number): ()
	function frame(self, ops: { any }): ()
	function blob(self, bytes: string, mime: string): string
end
```

One `cx` per running block, passed to `init`, `view`, `key`, `event` and
`resize`. Timers and process callbacks may retain it, but retaining it does
not keep the block alive or cancel asynchronous work when the block ends.

After the block ends, block-bound requests (`render`, `save`, `exit`,
`frame` and `blob`) are ignored when applied if no block is running in that
pane. `blob` still computes and returns its id; it does not store the blob
for an ended block. These checks are pane-based, not a lifetime token for
the retained context.

Effects are different: `toast`, `open` and `copy` can still be forwarded to
the windows showing the pane after the block ends. They are not guarded by
block liveness. Cancel asynchronous producers where possible and check
liveness before acting on their callbacks, especially before effects.
There is no block-close callback; see
[Updating in the background](../guides/blocks.md#updating-in-the-background)
for a `tern.pane.list()` check. Keep a local stopped flag as well when your
own code calls `cx:exit()`, since requests apply only after the handler
returns.

| Member | Behavior |
| --- | --- |
| `cx.pane` | The pane's id on its host |
| `cx.cwd` | The pane's working directory when the block started, or `nil` |
| `cx.cols`, `cx.rows` | The pane's current size in cells (updated before `resize` runs) |
| `cx:render()` | Queues a render: `view`, title, `save`, as after a handler. Use it after changing state from a timer, process or fetch callback |
| `cx:save()` | Queues `save` and stores the result now if it changed |
| `cx:exit(code?)` | Ends the block with exit status `code` (default `0`): its surface closes and the pane's program has exited |
| `cx:frame(ops)` | Sends `ops`, a list of raw surface protocol frame ops, as one frame. Raises `cx:frame: ops must be a list` |
| `cx:blob(bytes, mime)` | Sends `bytes` as a blob of type `mime` and returns its id (the SHA-256 of the bytes, lowercase hex) for an `image` node's `blob` prop |
| `cx:toast`, `cx:open`, `cx:copy` | As on [Effect cx](#effect-cx), aimed at the windows showing this pane |

Requests apply after the current handler returns, in order. A render that
queues another render repeats at most 8 rounds per handler; past that the
rest are dropped with the log message `plugin keeps re-rendering; requests
dropped`.

`cx:frame` bypasses the view diff: the next render still diffs against the
last `view` result, not against what raw ops changed.

```lua
init = function(cx, _args, _saved)
	local state = { lines = {} }
	tern.process.run({ "uptime" }, function(r)
		local live = false
		for _, pane in tern.pane.list() do
			if pane.pane == cx.pane then
				live = true
				break
			end
		end
		if not live then
			return
		end
		table.insert(state.lines, r.stdout)
		cx:render()
	end)
	return state
end,
```

## `tern.lens.define`

```lua
tern.lens.define: (id: string, def: LensDef<any>) -> ()
```

Implements command lens `id`, which `plugin.toml` must declare in a
`[[lenses]]` table with its `match` globs. The lens id is
`plugin.<plugin>.<id>` and its blocks' role is `lens.plugin.<plugin>.<id>`.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | A `[[lenses]]` `id` of this plugin |
| `def` | `LensDef<S>` | The handlers below |

Raises:

- `tern.lens.define: lens "<id>" is not declared in plugin.toml`;
- ``tern.lens.define: <id>: `open` must be a function`` (and the same for
  `line`, `finish`, `view`).

A declared lens still undefined when the entry finishes fails the plugin:
`lens <id> is declared in plugin.toml but not defined with tern.lens.define`.

### `LensDef`

```lua
type LensDef<S> = {
	open: (run: LensRun, cx: EffectCx) -> S,
	line: (state: S, l: LensLine) -> (),
	finish: (state: S, status: number?) -> (),
	view: (state: S) -> Node?,
	event: ((state: S, ev: UiEvent, cx: EffectCx) -> ())?,
}
```

| Field | Required | Called | Hook name |
| --- | --- | --- | --- |
| `open(run, cx)` | yes | When a claimed command starts; returns the state | `<id>.open` |
| `line(state, l)` | yes | For each output line | `<id>.line` |
| `finish(state, status)` | yes | When the command finishes, with its exit status | `<id>.finish` |
| `view(state)` | yes | While output arrives (coalesced), at finish, after each `event` | `<id>.view` |
| `event(state, ev, cx)` | no | On a user event from the lens block's view | `<id>.event` |

Whether a command gets this lens is decided by the manifest's `match` globs
alone, before any Lua runs, so `open` cannot decline: the block exists once
the pattern matched. Narrow `match` instead. See [Command Lenses](../guides/lenses.md)
and [Manifest Reference](manifest.md#lenses) for the claim order.

`view` returning `nil` leaves the block showing the command's raw output; a
node replaces it with a native view. While the command runs, `view` runs at
most once per 250 ms per block (only when lines arrived since the last view),
then once at finish. If `open` raises, the capture has no state and the block
keeps its raw output.

`finish` always receives the numeric exit status (the declaration's `nil`
case does not occur). A capture that ends without finishing (aborted, pane
closed) gets no `finish`; its state is dropped.

### `LensRun`

```lua
type LensRun = {
	line: string,
	typed: string,
	cwd: string?,
	program: string,
	args: { string },
}
```

| Field | Meaning |
| --- | --- |
| `line` | The command line the shell reports (alias-expanded), else as typed |
| `typed` | The line as typed |
| `cwd` | The shell's working directory, when known |
| `program` | The program name without directories, after wrappers (`sudo`, `doas`, `exec`, `time`, `nice`, `nohup`, `env`, `command`, `builtin`, `caffeinate`, `npx`, `bunx`, `pnpx`, `uvx`, `pipx`) and `VAR=value` prefixes |
| `args` | Its arguments, unquoted, redirections removed |

### `LensLine`

```lua
type LensLine = {
	text: string,
	links: { LensLink },
}

type LensLink = {
	from: number,
	to: number,
	href: string,
}
```

| Field | Meaning |
| --- | --- |
| `text` | The line's text, without escape sequences |
| `links` | Links the terminal found on the line |
| `links[i].from`, `links[i].to` | First and last byte of the link in `text`, 1-based and inclusive (`string.sub(l.text, link.from, link.to)`) |
| `links[i].href` | The link target |

### Lens state and rehydration

The worker keeps the state of the last 256 captures per plugin; past that it
drops finished captures first, least recently used first. A user event on a
lens block whose state is gone (dropped, or lost to a reload or daemon
restart) rebuilds it: the worker matches the block's saved command line
against the plugin's current `match` globs, calls `open`, feeds the saved raw
output through `line` (re-split at the width it was captured at), calls
`finish` when the command had finished, then runs `event`. If the current
globs no longer claim the line, the event is dropped.

### Example

```lua
tern.lens.define("grep", {
	open = function(run, _cx)
		return { cwd = run.cwd, rows = {} }
	end,
	line = function(state, l)
		local path, line = tern.parse.location(l.text)
		if path and line then
			table.insert(state.rows, {
				{ tern.ui.path(path, state.cwd), tern.ui.span(":" .. line) },
				{ tern.ui.span(l.text) },
			})
		end
	end,
	finish = function(_state, _status) end,
	view = function(state)
		if #state.rows == 0 then
			return nil
		end
		return tern.ui.table({
			{ id = "at", head = "Where" },
			{ id = "text", head = "Line", grow = 1 },
		}, state.rows)
	end,
})
```

```toml
[[lenses]]
id = "grep"
match = ["rg TODO*", "grep * TODO *"]
```

## Effect cx

```lua
declare extern type EffectCx with
	function toast(self, level: ToastLevel, text: string, sub: string?): ()
	function open(self, target: string): ()
	function copy(self, text: string): ()
end
```

The `cx` of lens `open` and `event` and of host event handlers. Its requests
go to the windows of the pane concerned: every window of that pane's window
key (in practice, every window showing its session). The `cx` holds only its
target, so it may be kept and used later.

| Method | Behavior |
| --- | --- |
| `cx:toast(level, text, sub?)` | Shows a toast. `"success"` is success; `"error"`, `"warn"` and `"warning"` show as errors; any other level shows as info |
| `cx:open(target)` | Opens a path or URL in each receiving window as a link clicked in the pane would open, so that window's `tern.route.link` and `tern.route.open` handlers apply |
| `cx:copy(text)` | Puts `text` on each receiving window's clipboard |

None raise. With no window attached, the requests are dropped.

## `tern.on`

```lua
tern.on: (name: string, fn: (...any) -> ...any) -> ()
```

Subscribes `fn` to host event `name`. Handlers of one plugin run in
registration order; each plugin's worker runs its own, so handlers of
different plugins run concurrently and in no defined order.

| Event | Handler | Payload |
| --- | --- | --- |
| `spawn` | `(spec: SpawnSpec) -> SpawnSpec?` | See below |
| `command_started` | `(ev, cx: EffectCx)` | `{pane, line, cwd?}` |
| `command_finished` | `(ev, cx: EffectCx)` | `{pane, line, status, took_ms}` |
| `cwd` | `(ev, cx: EffectCx)` | `{pane, path}` |
| `title` | `(ev, cx: EffectCx)` | `{pane, title}` |
| `pane_exited` | `(ev, cx: EffectCx)` | `{pane, status}` |

Raises `tern.on: unknown host event "<name>" (spawn, command_started,
command_finished, cwd, title, pane_exited)`.

The hook name of each handler is the event name. [Events](events.md#host-events)
gives each event's fields and when it fires.

### The spawn filter

```lua
type SpawnSpec = {
	program: string,
	args: { string },
	cwd: string?,
	env: { [string]: string },
}
```

A `spawn` handler runs synchronously before every shell pane on this host
starts (never for plugin blocks). It receives the spec and returns a spec to
use instead, or `nil` to leave it unchanged.

| Field | Meaning |
| --- | --- |
| `program` | The program to run |
| `args` | Its arguments |
| `cwd` | The working directory |
| `env` | The variables Tern sets on top of the inherited environment |

A returned table replaces the spec field by field:

- `program` or `args` missing: the previous value stays;
- `cwd` missing: no directory is set from the filter, and the pane starts
  where it would have; a `cwd` that is not a directory is ignored (the
  daemon expands a leading `~`);
- `env`: the result's `env` is the complete set of variables. Keys missing
  from it are removed; keys absent before are added (sorted by name).
  A result without `env` removes them all.

Return the spec you received, modified, rather than a new partial table.

Plugins run in id order, each seeing the previous plugin's result. The pane
waits at most 50 ms for each plugin; a slower plugin's result is discarded
(the pane starts anyway) with the log message `plugin spawn filter took over
50 ms; skipped`. Several `spawn` handlers in one plugin run in registration
order within that plugin's 50 ms.

A `spawn` handler that returns something other than a table or `nil` is
reported: `spawn must return a spec table or nil, got <type>`. Its failures
are toasted to every window.

```lua
tern.on("spawn", function(spec)
	spec.env.EDITOR = "nvim"
	return spec
end)
```

## `tern.pane`

### `tern.pane.write`

```lua
tern.pane.write: (pane: number, text: string) -> ()
```

Writes `text` to pane `pane`'s pty, as if typed. End it with `"\r"` to run a
shell command. The write is queued and applied after the handler returns; an
unknown pane is ignored. Nothing raises for a missing pane.

```lua
tern.on("cwd", function(ev, _cx)
	if ev.path:match("/node_modules$") then
		tern.pane.write(ev.pane, "cd ..\r")
	end
end)
```

### `tern.pane.list`

```lua
tern.pane.list: () -> { PaneInfo }

type PaneInfo = {
	pane: number,
	cwd: string?,
	program: string,
	title: string,
	busy: boolean,
}
```

Every pane on this host whose program hasn't exited, as the owner last
reported them. A block's own pane is listed before its `init` runs.

| Field | Meaning |
| --- | --- |
| `pane` | Pane id on this host (the id `tern.pane.write` and event payloads use) |
| `cwd` | Its working directory |
| `program` | Its program name, or the block kind for a plugin block |
| `title` | Its title |
| `busy` | Whether shell integration reports a command running; `false` after exit |

## Related pages

- [Blocks](../guides/blocks.md) and [Command Lenses](../guides/lenses.md)
  for walkthroughs.
- [Host Hooks and the Spawn Filter](../guides/hooks.md).
- [Events](events.md) and [Limits](limits.md).
