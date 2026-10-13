# Command Lenses

A lens turns the output of a shell command into a native view: a table, a
chart, a list of diagnostics. The plugin's manifest decides which command
lines it claims, and its host half reads the output line by line and returns
a view, while Tern keeps the raw output one click away. This page follows a
command from the prompt to the view, then through reloads and restarts.

## How a command gets a lens

When a shell with Tern's integration starts a command, it reports the
command line. Then:

1. Tern reads the line as a simple command. A line that isn't one stays
   plain terminal output.
2. It tries the plugins' `match` globs. On a match, the command's output is
   diverted into a block that the claiming lens reads.
3. Otherwise it asks the built-in lenses, and with no taker the output stays
   plain terminal output.

### Reading the command line

The line Tern reads is the alias-expanded one when the shell reports it
(zsh does), else the line as typed. It is split the way the shell would
split it, quotes and escapes included, and then:

- leading `VAR=value` assignments are skipped;
- wrapper programs are skipped with their options: `sudo`, `doas`, `exec`,
  `time`, `nice`, `nohup`, `env`, `command`, `builtin`, `caffeinate`,
  `npx`, `bunx`, `pnpx`, `uvx`, `pipx`;
- the program loses its directories (`/usr/bin/du` reads as `du`);
- redirections of stderr and stdin (`2>&1`, `2>/dev/null`, `< input`) are
  removed from the arguments.

Some lines are never lensed, because the output on the screen isn't the
program's alone: pipelines (`du -sh * | sort -h`), lists (`clear; du`,
`make && du`), stdout redirections (`du > sizes.txt`), subshells, heredocs,
and command substitution in the program word.

| Typed | Matched against |
| --- | --- |
| `du -sh src` | `du -sh src` |
| `sudo -u root du -sh /var` | `du -sh /var` |
| `LC_ALL=C du -sh "my dir"` | `du -sh my dir` |
| `du -sh src 2>/dev/null` | `du -sh src` |
| `du -sh src \| sort -h` | nothing: a pipeline |
| `du -sh src > out.txt` | nothing: stdout is redirected |

### Matching

The text a pattern sees is the program and its arguments joined by single
spaces. `match` patterns are globs over all of it: `*` is any run of
characters (none included), `?` exactly one character, everything else
matches itself, case-sensitively.

| Pattern | Matches | Doesn't match |
| --- | --- | --- |
| `du *` | `du -sh src`, `du .` | `du` (nothing after the space) |
| `du` | `du` | `du .` |
| `kubectl get *` | `kubectl get pods` | `kubectl get`, `k get pods` |
| `terraform plan*` | `terraform plan`, `terraform plan -out x` | `terraform apply` |

To claim a bare program and the program with arguments, list both:
`match = ["du", "du *"]`.

### Who wins

Claims are tried before the built-in lenses. Among plugins, Tern takes the
Ready plugins that declare lenses in id order, and for the first plugin with
a matching pattern, the first of its lenses in manifest order. Exactly one
lens claims a command; a plugin claim also keeps the built-in lens for that
command from running, even when your `view` later returns `nil`.

| Manifest `[[lenses]]` | Line | Lens |
| --- | --- | --- |
| plugin `ops`: `get` = `kubectl get *`; `all` = `kubectl *` | `kubectl get pods` | `ops.get` |
| same | `kubectl logs web` | `ops.all` |
| plugin `aa`: `k` = `kubectl *`, plus plugin `ops` above | `kubectl get pods` | `aa.k` (id `aa` sorts first) |

Order your manifest from narrow to broad, and keep patterns as narrow as the
output you can actually read.

### Why claims are declarative

Every replica of a pane runs the same terminal on the same bytes: the
daemon, each window showing the pane, the iOS app and the web client. Each
must divert the same commands into the same blocks, but only the host runs
your Lua. So the claim is decided by data every replica has (the manifest's
globs, sent to windows in the plugin catalog) before any Lua runs. That is
why `open` cannot decline a command: by the time it runs, the block exists
everywhere. If you can't read some form of the command's output, narrow
`match`, or return `nil` from `view` to show the raw output.

### When nothing is lensed

Lenses also need:

- the shell integration, which reports the command line;
- Settings › Terminal › **Native command output** (`command_lenses`) on, the
  default; off, no command gets any lens, plugin or built-in;
- the pane on its main screen with no program surface open.

A capture that turns interactive (the alternate screen, keypad or mouse
modes, a cursor position query) or passes 16 MiB is aborted: the block is
dropped and everything captured is replayed into the terminal grid. An
aborted capture gets no `finish` and its state is dropped.

## Defining a lens

Declare the lens in `plugin.toml`, then implement it in `host.luau` with
`tern.lens.define(id, def)`:

```toml
[[lenses]]
id = "du"
match = ["du", "du *"]
```

| Field | Required | Called |
| --- | --- | --- |
| `open(run, cx) -> state` | yes | When a claimed command starts |
| `line(state, l)` | yes | For each output line |
| `finish(state, status)` | yes | When the command ends, with its exit status |
| `view(state) -> Node?` | yes | While output arrives, at finish, and after each `event` |
| `event(state, ev, cx)` | no | When someone acts on the view |

A lens declared in the manifest but not defined when `host.luau` finishes
loading fails the plugin. The state `open` returns is passed to every other
handler; mutate it in place. Every call has the host's 2 s budget.

### `run`

| Field | Meaning |
| --- | --- |
| `line` | The command line Tern read (alias-expanded when the shell reported it) |
| `typed` | The line as typed |
| `cwd` | The shell's working directory, when known |
| `program` | The program, after wrappers and assignments, without directories |
| `args` | Its arguments, unquoted, stderr and stdin redirections removed |

Use `run.cwd` to resolve relative paths in the output (`tern.ui.path(p,
run.cwd)` makes a clickable path), and `run.args` to adapt to flags.

### Lines

Each `l` is one logical line of output:

```lua
l = {
	text = "12K\tsrc",
	links = { { from = 5, to = 7, href = "file:///home/me/src" } },
}
```

- `text` has escape sequences already applied: colors are gone, a line a
  progress bar rewrote with `\r` arrives as it finally looked, and rows the
  terminal soft-wrapped are joined back into one line. Trailing blanks are
  trimmed. Output written to stderr is part of the stream, in order.
- `links` are the hyperlinks the program printed (OSC 8), with `from` and
  `to` the first and last byte of the link text, 1-based and inclusive, so
  `string.sub(l.text, link.from, link.to)` is the linked text.

Tern replays the output on an 8-row scratch screen and hands a line over
when it scrolls off, so the last rows of output arrive just before
`finish`. A command that prints a few lines and then works for a minute
shows them only when it ends.

`finish` receives the exit status as a number.

### Views while the command runs

`view` returns one node (see [Building Views](views.md)) or `nil`:

- **A node** replaces the raw output in the block. The block keeps its
  Native/Raw toggle, and Copy still copies the raw text.
- **`nil`** leaves the block showing the raw output, as a finished block.
  The built-in lens does not get a second chance.

While the command runs, Tern calls `view` at most once per 250 ms per block,
and only when lines arrived since the last call; then once at finish, and
once after every `event`. Each result replaces the previous view whole: a
lens view is not diffed the way a block's is. Keep `line` cheap and do
formatting in `view`, but remember `view` may run many times over a long
capture. Cap what you show: the built-in lenses stop at 5,000 rows and end
with `tern.ui.overflow(hidden)`.

## Actions and events

A node with an `actions` prop is clickable. A custom action name arrives at
`event`:

```lua
local node = tern.ui.badge("By name", "muted")
local p: { [string]: any } = node.p or {}
p.actions = { click = "sort=name" }
node.p = p
```

```lua
event = function(state, ev, cx)
	if ev.ev == "action" and ev.act == "sort" then
		state.by = ev.value -- "name"
	end
end,
```

The click arrives as `{ev = "action", id = …, act = "sort", value =
"name"}`: an action name holding `=` is split into `act` and `value`, and
`mods` lists the modifiers held (`"shift"`, `"ctrl"`, `"alt"`, `"meta"`)
when there are any. `id` is an id Tern gave the node; it is not stable
across views, so put what was clicked in the action name instead.
[Building Views](views.md#actions-and-events) lists every event and the
built-in action names.

`event` receives every event the lens view produces, so check `ev.ev`. `view`
runs after it, which is how the view reflects the change.

The `cx` passed to `open` and `event` has three methods. Their effects go to
the windows showing the pane, not to the pane itself:

| Method | Effect |
| --- | --- |
| `cx:toast(level, text, sub?)` | A toast; `level` is `"success"`, `"info"` or `"error"` |
| `cx:open(target)` | Opens a path or URL as a link clicked in the pane would, so the window's routes apply |
| `cx:copy(text)` | Puts `text` on the clipboard |

## State, reloads and restarts

Lens state lives on the plugin's worker, never with the pane. The worker
keeps the state of the last 256 captures per plugin, dropping finished
captures first and least recently used first. A reload starts a new worker:
running captures finish on the old one, and finished captures' state is
gone.

The view itself survives all of this. It is part of the pane's screen, so
it stays visible after a reload, in a window that attaches later, and after
a daemon restart. What's missing is the state behind it, which a click
needs. When an event arrives for a block whose state is gone, the worker
rebuilds it from what the block keeps (the command line, the working
directory, the raw output and the exit status):

1. it matches the saved command line against the plugin's current `match`
   globs; if they no longer claim it, the event is dropped;
2. it calls `open` with a fresh `cx`;
3. it feeds the saved raw output through `line`, re-split at the width it
   was captured at;
4. it calls `finish` when the command had finished;
5. it runs `event`, then `view`.

This rehydration has consequences for how you write a lens:

- **State must be derivable from `run` and the lines.** Anything else, such
  as data a process fetched or a value read from the clock, comes back
  different or not at all.
- **Choices made by earlier events are lost.** A sort order picked before a
  restart reverts to the default before the new event applies. Keep such
  choices small or make each event carry the whole choice (`sort=name`, not
  `toggle_sort`).
- **`open`, `line` and `finish` can run again.** Don't toast, write files or
  start processes from them.

## Turning lenses off

| To stop | Do |
| --- | --- |
| One block | Switch it to **Raw** |
| Every lens, built-in and plugin | Turn off Settings › Terminal › **Native command output** |
| One plugin's lenses | Turn the plugin off in Preferences › Plugins (it adds the id to `plugins_disabled` in `settings.json`), which disables the whole plugin |
| One lens | Narrow or remove its `match` patterns in the manifest; there is no per-lens switch |

## Worked example: `du` as a table

`du` prints one entry per line, size first. This lens shows the entries as a
table with a bar for each entry's share of the largest, sortable by size or
name, and keeps lines it can't read (such as permission errors) under the
table.

`plugin.toml`:

```toml
schema = 1
id = "disk"
name = "Disk Usage"
version = "0.1.0"
description = "du output as a sortable table with share bars."
host = "host.luau"

[[lenses]]
id = "du"
match = ["du", "du *"]
```

`host.luau`:

```lua
--!strict
-- `du` as a table: one row per entry, a bar for its share of the largest,
-- sortable by size or name. Works with and without -h: sizes are shown as
-- printed and compared through tern.parse.size.

local ui = tern.ui

local MAX_ROWS = 500

type Row = { size: string, bytes: number, path: string }
type State = {
	cwd: string?,
	rows: { Row },
	other: { string },
	by: string,
}

local function badge(label: string, active: boolean, act: string): Node
	local node = ui.badge(label, if active then "accent" else "muted")
	local p: { [string]: any } = node.p or {}
	p.actions = { click = act }
	node.p = p
	return node
end

local du: LensDef<State> = {
	open = function(run, _cx)
		return { cwd = run.cwd, rows = {}, other = {}, by = "size" }
	end,

	line = function(state, l)
		local size, path = string.match(l.text, "^%s*(%S+)%s+(.+)$")
		local bytes = if size then tern.parse.size(size) else nil
		if size and path and bytes then
			table.insert(state.rows, { size = size, bytes = bytes, path = path })
		elseif l.text ~= "" then
			table.insert(state.other, l.text) -- `du: ...: Permission denied`
		end
	end,

	finish = function(_state, _status) end,

	view = function(state)
		if #state.rows == 0 then
			return nil
		end
		local rows = table.clone(state.rows)
		if state.by == "name" then
			table.sort(rows, function(a, b)
				return a.path < b.path
			end)
		else
			table.sort(rows, function(a, b)
				return a.bytes > b.bytes
			end)
		end
		local largest = 1
		for _, r in rows do
			largest = math.max(largest, r.bytes)
		end
		local cells: { { Cell } } = {}
		for i = 1, math.min(#rows, MAX_ROWS) do
			local r = rows[i]
			cells[i] = {
				{ ui.span(r.size, "num") },
				ui.meter_cell(r.bytes / largest),
				{ ui.path(r.path, state.cwd) },
			}
		end
		local head: { Node } = {
			ui.text({ ui.span(tostring(#rows), "strong num"), ui.span(" entries", "muted") }),
			badge("By size", state.by == "size", "sort=size"),
			badge("By name", state.by == "name", "sort=name"),
		}
		local body: { Node } = {
			ui.row(head),
			ui.table({
				{ id = "size", head = "Size", align = "end" },
				{ id = "share", head = "Share", priority = -1 },
				{ id = "path", head = "Path", grow = 1, truncate = "middle" },
			}, cells),
		}
		if #rows > MAX_ROWS then
			table.insert(body, ui.overflow(#rows - MAX_ROWS))
		end
		for _, text in state.other do
			table.insert(body, ui.text({ ui.span(text, "warning") }))
		end
		return ui.col(body)
	end,

	event = function(state, ev, _cx)
		if ev.ev == "action" and ev.act == "sort" then
			state.by = if ev.value == "name" then "name" else "size"
		end
	end,
}

tern.lens.define("du", du)
```

Notes on the choices:

- `match` lists `du` and `du *`, since `du *` alone needs at least one
  argument.
- `line` only parses and appends; sorting and building rows happen in
  `view`, which runs at most four times a second while `du` works.
- The table's `priority = -1` on the bar column hides it first when the
  pane is narrow; `truncate = "middle"` keeps both ends of long paths.
- `ui.path(r.path, state.cwd)` makes each path a link resolved against the
  directory `du` ran in, so a click opens it through the window's routes.
- The view shows no exit badge: a lens block already marks a failing exit.
- The sort badges send `sort=size` and `sort=name`. Each click carries the
  whole choice, so it works the same on rehydrated state, where `by` starts
  over at `"size"`.

## Related pages

- [Host API](../reference/api-host.md#ternlensdefine): every field and message.
- [Building Views](views.md): nodes, builders, actions and CSS.
- [Manifest Reference](../reference/manifest.md): `[[lenses]]`.
- [Architecture](../concepts/architecture.md) and
  [Lifecycle and Reload](../concepts/lifecycle.md#lens-rehydration).
