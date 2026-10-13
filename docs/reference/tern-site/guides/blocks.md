# Blocks

A plugin block is a pane whose program is your Lua. It lives in the session
daemon's pane table like a shell, so every window, the iOS app and the web
client show it, and it survives closed windows, plugin reloads and daemon
restarts. This page covers how a block is defined, rendered, driven by keys,
events and background work, saved and restored, and opened.

## What a block is

A block type is declared in the manifest and implemented in the host half.
Each running block is one pane on the host, with:

- **state**, the value your `init` returns, kept on the plugin's worker;
- **a view**, the node tree your `view` returns, which the worker diffs and
  sends to the pane as surface protocol frames;
- **a saved value**, what your `save` returns, stored with the pane by the
  daemon.

Windows hold no Lua for a block. They draw the frames the pane sends and
send back keys and pointer events, exactly as they would for any program
drawing a native surface. That is why a block works in a window whose
plugin halves never ran, such as the web client.

## Declaring and defining

```toml
[[blocks]]
id = "list"
title = "Checklist"
```

The block's kind is `<plugin>.<id>`, here `checklist.list` for plugin
`checklist`. `title` labels the palette row "New Checklist block" and is the
pane title until your `title` handler gives one. The optional keys `icon`,
`files` and `palette` are in [Manifest Reference](../reference/manifest.md).

`host.luau` implements it with `tern.block.define(id, def)`:

| Field | Required | Called |
| --- | --- | --- |
| `init(cx, args, saved) -> state` | yes | When the block starts, and when it restarts after a reload or a daemon restart |
| `view(state, cx) -> {main?, dock?, layer?}` | yes | After every handler and every `cx:render()` |
| `title(state) -> string?` | no | After every `view` |
| `key(state, key, cx) -> boolean?` | no | For each key press and paste while the pane has focus; return exactly `false` for a key that changed nothing |
| `event(state, ev, cx)` | no | When someone acts on the view's nodes |
| `resize(state, cols, rows, cx)` | no | When the pane's size in cells changes; without it the block re-renders on its own |
| `save(state) -> any` | no | After every handler (except a `key` that returned `false`), and on `cx:save()` |

A block declared but not defined when `host.luau` finishes loading fails the
plugin. Every call has the host's 2 s budget.

## The block `cx`

Every handler except `title` and `save` receives the block's `cx`. There is
one per running block, so timers and process callbacks may keep it, but
retaining it neither keeps the block alive nor cancels background work.
After the block ends, `render`, `save`, `exit`, `frame` and `blob` requests
are ignored when applied if no block is running in that pane (`blob` still
returns its computed id). The checks are pane-based, not a retained-context
lifetime token. `toast`, `open` and `copy` are not guarded by block liveness
and can still affect the windows after the block ends.

| Member | Meaning |
| --- | --- |
| `cx.pane` | The pane's id on its host |
| `cx.cwd` | The pane's working directory when the block started, or `nil` |
| `cx.cols`, `cx.rows` | The pane's size in cells, updated before `resize` runs |
| `cx:render()` | Re-renders: `view`, title and `save`, as after a handler |
| `cx:save()` | Runs `save` and stores the result now if it changed |
| `cx:exit(code)` | Ends the block with exit status `code` |
| `cx:frame(ops)` | Sends raw surface protocol frame ops |
| `cx:blob(bytes, mime)` | Sends bytes (an `"image/png"`, say) and returns the blob id for an `image` node's `blob` prop |
| `cx:toast(level, text, sub?)` | A toast in the windows showing the pane |
| `cx:open(target)` | Opens a path or URL in those windows, through their routes |
| `cx:copy(text)` | Copies to their clipboard |

Requests made through the `cx` are queued and applied after the current
handler returns, in order, so no handler runs inside another.

## The render cycle

You never send a view yourself. After every handler (`init`, `key` unless
it returned exactly `false`, `event`, `resize`) and every `cx:render()`,
the worker:

1. calls `view` and diffs the result against the last view it sent;
2. sends one frame with the changes, if there are any;
3. calls `title` and sends the title if it changed;
4. calls `save` and stores the result if its JSON changed.

A resize of a block without a `resize` handler runs steps 1 to 3: the view
may read `cx.cols` and `cx.rows`, but nothing changed the state to save.

So the model is: mutate `state` in a handler, return, and the view follows.
A handler that raises loses its call, is reported as a toast "Plugin
*name*: list.key failed", and the render after it still runs. A `view` that
raises or returns something malformed is reported the same way, and the last
good view stays on screen.

## Regions, node ids and keys

`view` returns up to three regions:

| Region | Where |
| --- | --- |
| `main` | The block's area |
| `dock` | A strip under it |
| `layer` | A layer over it, for sheets and overlays |

A region you leave out shows nothing. Each region's root node is the region
itself: Tern draws its children into the pane, and applies the root's
`role` prop to the region element, but doesn't draw the root's own content.
Make every region root a container, such as `ui.col({ … })`; a bare
`main = ui.text(…)` shows nothing.

The worker names every node so it can diff views. A region's root is named
after the region (`main`), and each child is `<parent id>.<key>`, where
`key` is the child's `p.key` when it has one (a string or a number), else
its 0-based index among its siblings:

```text
main                 ui.col({ listing })
main.items           the list, p.key = "items"
main.items.i7        an item, p.key = "i7"
main.items.i3        an item, p.key = "i3"
dock.0               the dock's first child, unkeyed
```

Between two views, a node with the same id and kind gets only its changed
props; a text node whose text grew by a suffix gets an append; a kind
change replaces the node; children that disappear, appear or move are
deleted, added and moved by id.

Keys matter for anything that can be reordered, inserted or deleted.
Unkeyed, the third item of a list is `main.items.2` whatever it shows, so
deleting the first item shifts every id: each row gets rewritten, and Tern's
view state (scroll position, focus, a section's collapsed state) stays with
the old position instead of the item. Keyed by something stable, such as
an item id, a row keeps its id and its view state wherever it moves, and
the diff only moves it. Two siblings with the same key are an error
(`main.items: duplicate child key "i3"`), and that view is rejected.

Ids are also how a view refers to its own nodes: a list's `selected` prop
holds the id of the selected item, and events report the node acted on in
`ev.id`.

## Keys and paste

When the block's pane has focus, keys reach it the way they reach any
program: the window's key bindings take the keys they bind first, and every
other key goes to `key`:

```lua
key = { name = "j", text = "j", ctrl = false, alt = false, shift = false, meta = false }
```

`name` is the key: a lowercase character (`"a"`, `"+"`) or a named key
(`"enter"`, `"tab"`, `"backspace"`, `"escape"`, `"space"`, `"up"`, `"down"`,
`"left"`, `"right"`, `"home"`, `"end"`, `"page_up"`, `"page_down"`,
`"delete"`, `"f1"` to `"f35"`, …). `text` is what the key types, when it
types something. `meta` is Cmd on macOS. The full list is in
[Host API](../reference/api-host.md#key).

A paste arrives as one call with `name = "paste"` and `text` holding the
pasted text, newlines included.

`key`'s return value decides whether a render follows. Return exactly
`false` when the key changed nothing: the worker skips the render and the
save, so keys the block ignores cost no `view` call. Any other return
(`true`, or nothing at all) renders and saves. A handler that changes the
state and then returns `false` leaves the view (and the saved state) behind
until something else renders it, so return `true` (or nothing) from every
branch that changes something and `false` only for keys you don't use. The
return value doesn't route keys: a key `key` ignores is not passed anywhere
else.

When the pane resizes, `cx.cols` and `cx.rows` change and the block
re-renders, so a `view` that lays out by `cx.cols` follows the pane with no
`resize` handler. A `resize` handler runs first when there is one (to
recompute something from the new size), then the block renders and saves;
without one it only renders.

## Events from the view

Nodes with an `actions` prop send events when clicked. With
`p.actions = { click = "check=7" }` on a node, `event` receives:

```lua
ev = { ev = "action", id = "main.items.i7", act = "check", value = "7" }
```

The name is split at its first `=` into `act` and `value`, and `mods` lists
the modifiers held, when any. `event` also receives `select`, `activate`
and `toggle` events from nodes that ask for them, and `change` events from
checkboxes and radios ([Forms and controls](views.md#forms-and-controls)). The full list and the
built-in action names are in [Building Views](views.md#actions-and-events).

## Updating in the background

Handlers run when something happens to the block. To change the view on
your own schedule (a poll, a finished process), change `state` from a timer,
process or fetch callback and call `cx:render()`. Host-side timer, process
and fetch callbacks receive no `cx`, so keep the block's `cx` from `init` in
a closure.

A block has no "closed" handler, so background work must notice the block
is gone on its own. `tern.pane.list()` lists the host's panes whose program
hasn't exited, blocks included; stop when the block's pane isn't there.
Cancel producers where possible and check again in completion callbacks
before updating state or sending effects. When your own code ends the block
with `cx:exit()`, also set a local stopped flag before queuing the exit:
the pane list does not reflect queued requests until the handler returns.

This block runs its launch arguments as a command every two seconds and
shows the output:

```lua
--!strict
local ui = tern.ui

type WatchState = { argv: { string }, out: string, status: number?, at: number }

local EVERY_MS = 2000

-- Whether pane `pane` still runs (a block that ended is gone from the list).
local function running(pane: number): boolean
	for _, p in tern.pane.list() do
		if p.pane == pane then
			return true
		end
	end
	return false
end

local watch: BlockDef<WatchState> = {
	init = function(cx, args, _saved)
		local state: WatchState = { argv = args, out = "", status = nil, at = 0 }
		local function tick()
			if not running(cx.pane) then
				return
			end
			tern.process.run(state.argv, { cwd = cx.cwd, timeout_ms = 10000 }, function(r)
				if not running(cx.pane) then
					return
				end
				state.out, state.status, state.at = r.stdout .. r.stderr, r.status, tern.now()
				cx:render()
				tern.timer(EVERY_MS, function()
					if running(cx.pane) then
						tick()
					end
				end)
			end)
		end
		if #args > 0 then
			tick()
		end
		return state
	end,
	title = function(state)
		return if #state.argv > 0 then "watch " .. table.concat(state.argv, " ") else nil
	end,
	view = function(state, _cx)
		if #state.argv == 0 then
			return { main = ui.col({ ui.text({ ui.span("Pass the command to run as arguments", "muted") }) }) }
		end
		return {
			main = ui.col({ ui.ansi(state.out) }),
			dock = ui.row({ ui.text({
				ui.span(if state.status == 0 then "ok" else "exit " .. tostring(state.status), if state.status == 0 then "success" else "error"),
				ui.span(" · every " .. EVERY_MS // 1000 .. "s", "muted"),
			}) }),
		}
	end,
}

tern.block.define("watch", watch)
```

Liveness is checked before launching each process, in its completion
callback, and in the timer before scheduling another run.
The block's own pane is listed from before `init` runs, so the same check in
`init` passes too. The process itself runs on
a pool thread, so the worker stays free for keys and other blocks in the
meantime. A reload stops the old worker, timers included, and the block's
new `init` starts the loop again.

## Saving and restoring

A block restarts in two situations: a plugin reload moves running blocks to
the new worker, and a daemon restart restores them with the rest of the
session. Both call `init` again with the same `args` and with `saved`, the
last value `save` returned, decoded from JSON. Nothing else carries over:
the state table, timers and processes of the old run are gone, and after a
daemon restart the block starts on a blank screen.

So whatever must survive goes through `save`:

- `save` returns JSON-able values: tables, strings, numbers, booleans,
  `tern.json.null`. It runs after every handler; the daemon stores the
  value only when its JSON changed, so returning the same value is cheap.
- Wrap lists that may be empty in `tern.json.array(t)`, or an empty list
  encodes as `{}`. Decoded arrays come back as Lua arrays.
- In `init`, prefer `saved` over `args` when both are present; `args` are
  the launch arguments and arrive every time.
- Keep derived and transient data (selection, scroll, caches) out of
  `save`, or restore it with defaults.

An `init` that raises ends the block: its error is printed in the pane and
the pane exits with status 1.

## Opening blocks

| From | How | `args` | Placement |
| --- | --- | --- | --- |
| Command palette | "New *title* block", for each Ready block type with `palette` not `false` on the current host | none | Beside the focused pane, or as the palette's placement modifier says |
| A file's menu | "Open with *title*" in the Files pane and file block menus, for block types whose `files` globs match the file name | `{ path }` | Beside the focused pane, in the file's folder |
| A route | `tern.route.open` or `tern.route.link` returning `{ block = "checklist.list", args = { … } }` | as given | Where the open would have gone |
| A window handler | `cx:new_block("checklist.list", args?, how?)` in a command, bind or event; returns the pane | as given | `how`, like `cx:open` |
| A layout | `{ block = "checklist.list", args = { … } }` as the `launch` of `cx.layout:new_tab`, `:split` or a workspace leaf | as given | That tab or split |

Kinds are `<plugin>.<block>`, without a `plugin.` prefix. The window must
see the kind in its host's catalog: a block type on a host whose plugin
failed or is disabled doesn't open. See [Routing Opens and Links](routing.md)
and [Layout and Workspaces](layout.md).

## Titles and exit

`title(state)` names the pane (and the tab, while the block is focused). It
runs after every `view`; a different string is sent, and `nil` keeps the
current title. Before any title, the pane shows the manifest `title`.

`cx:exit(code)` ends the block: it is removed from the worker, the pane's
program counts as exited with that status, and no reload restarts it. The
pane then behaves like any pane whose program exited. Use it for blocks
that finish, such as a wizard after its last step.

## Worked example: a checklist

A checklist that starts from its launch arguments, takes pasted lines as
new items, moves with `j`/`k` or the arrows, toggles with Space, Enter or a
click, deletes with `d`, and survives reloads and restarts.

`plugin.toml`:

```toml
schema = 1
id = "checklist"
name = "Checklist"
version = "0.1.0"
description = "A checklist pane that survives restarts."
host = "host.luau"

[[blocks]]
id = "list"
title = "Checklist"
```

`host.luau`:

```lua
--!strict
-- Block `checklist.list`: launch arguments become items; j/k (or the
-- arrows) move, space toggles, d deletes, pasted lines are added, clicks
-- toggle. Items keep their ids, so reorders and deletes keep view state.

local ui = tern.ui

type Entry = { id: number, text: string, done: boolean }
type State = { items: { Entry }, sel: number, seq: number }

local function add(state: State, text: string)
	local trimmed = string.match(text, "^%s*(.-)%s*$") or ""
	if trimmed ~= "" then
		state.seq += 1
		table.insert(state.items, { id = state.seq, text = trimmed, done = false })
	end
end

local function clickable(node: Node, act: string): Node
	local p: { [string]: any } = node.p or {}
	p.actions = { click = act }
	node.p = p
	return node
end

local function counts(state: State): (number, number)
	local done = 0
	for _, item in state.items do
		if item.done then
			done += 1
		end
	end
	return done, #state.items
end

local list: BlockDef<State> = {
	init = function(_cx, args, saved)
		if saved then
			return { items = saved.items or {}, sel = 1, seq = saved.seq or 0 }
		end
		local state: State = { items = {}, sel = 1, seq = 0 }
		for _, arg in args do
			add(state, arg)
		end
		return state
	end,

	title = function(state)
		local done, total = counts(state)
		return string.format("Checklist %d/%d", done, total)
	end,

	view = function(state, _cx)
		local rows: { Entry } = state.items
		local items = {}
		for i, item in rows do
			items[i] = {
				label = if item.done then { ui.span(item.text, "del muted") } else item.text,
				icon = if item.done then "check" else nil,
			}
		end
		local listing = ui.list(items)
		local children: { Node } = listing.c or {}
		for i, child in children do
			clickable(child, "check=" .. rows[i].id)
			local p: { [string]: any } = child.p or {}
			p.key = "i" .. rows[i].id
		end
		local current = rows[state.sel]
		listing.p = {
			key = "items",
			selected = if current then "main.items.i" .. current.id else nil,
			empty = { ui.span("Paste lines to add items", "muted") },
		}
		local done, total = counts(state)
		return {
			main = ui.col({ listing }),
			dock = ui.col({
				ui.row({
					ui.text({ ui.span(string.format("%d of %d done", done, total), "muted") }),
					clickable(ui.badge("Clear done", "accent"), "clear"),
				}),
			}),
		}
	end,

	key = function(state, key, _cx)
		local n = #state.items
		if key.name == "paste" then
			for line in string.gmatch(key.text or "", "[^\r\n]+") do
				add(state, line)
			end
		elseif key.name == "j" or key.name == "down" then
			state.sel = math.min(state.sel + 1, math.max(n, 1))
		elseif key.name == "k" or key.name == "up" then
			state.sel = math.max(state.sel - 1, 1)
		elseif key.name == "space" or key.name == "enter" then
			local item = state.items[state.sel]
			if item then
				item.done = not item.done
			end
		elseif key.name == "d" or key.name == "backspace" then
			table.remove(state.items, state.sel)
			state.sel = math.max(math.min(state.sel, #state.items), 1)
		else
			return false
		end
		return true
	end,

	event = function(state, ev, _cx)
		if ev.ev ~= "action" then
			return
		end
		if ev.act == "check" then
			for i, item in state.items do
				if tostring(item.id) == ev.value then
					item.done = not item.done
					state.sel = i
				end
			end
		elseif ev.act == "clear" then
			local kept = {}
			for _, item in state.items do
				if not item.done then
					table.insert(kept, item)
				end
			end
			state.items = kept
			state.sel = 1
		end
	end,

	save = function(state)
		return { items = tern.json.array(state.items), seq = state.seq }
	end,
}

tern.block.define("list", list)
```

How it uses the pieces above:

- **Stable keys.** Each item has an id from `seq`, which only grows and is
  saved, so `i7` means the same item before and after a delete, a reload or
  a restart. The list's `selected` prop names the selected item by its node
  id, `main.items.i<id>`, which follows from the keys: the list is keyed
  `items` under `main`.
- **Actions carry their target.** A click sends `check=<id>`, so `event`
  finds the item by `ev.value`, not by position.
- **Regions.** `main` and `dock` are both `col` roots; the dock's `row`
  sits inside its root so the count and the button line up.
- **What's saved.** Items and `seq` are saved; the selection isn't, and
  starts at the first item after a restart. `tern.json.array` keeps an empty
  list a JSON array.
- **Opening it.** "New Checklist block" in the palette opens an empty list.
  A window half could open a prepared one with
  `cx:new_block("checklist.list", { "Write tests", "Update docs" })`.

## Related pages

- [Host API](../reference/api-host.md#ternblockdefine): every field, op and
  message.
- [Building Views](views.md): builders, actions, tones and CSS.
- [Lifecycle and Reload](../concepts/lifecycle.md): what restarts when.
- [Files, Processes, and Storage](io.md): timers, processes and `tern.kv`.
