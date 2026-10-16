# Long-Running Commands

`longrun` notices the commands that keep you waiting. When a command line
runs past a threshold (15 seconds by default) it toasts the outcome as it
ends, keeps the last 50 such commands, and lists them in a "Slow Commands"
block next to the commands running right now. It is the smallest example
that uses both halves for one feature, with a module they share.

## What it demonstrates

| Surface | Half | Used for |
| --- | --- | --- |
| `tern.on("command_started" / "command_finished" / "pane_exited")` | Host | Timing every pane's commands, including panes no window shows |
| `EffectCx:toast` | Host | "cargo build --release finished in 1m 12s" |
| `tern.kv` | Host | The history and the threshold, as one writer |
| `tern.block.define` with `title`, `view`, `key`, `event` | Host | The Slow Commands block, its dock and its keys |
| `tern.timer`, `BlockCx:render` | Host | Live elapsed times, only while something runs |
| `tern.command`, `tern.bind` | Window | "Show slow commands" and its key |
| `cx.session:panes()`, `cx.layout:focus`, `cx:new_block` | Window | Focusing the block, or opening it |
| Window events, `cx.session:focused()`, `cx.session:panes()` | Window | Refreshing focus and command liveness from current snapshots |
| `tern.chrome.status`, `tern.chrome.refresh`, `tern.timer` | Window | A status segment with the focused pane's running time, ticking once a second |
| `require("./common")` | Both | Shared parsing and formatting |

## Install

```sh
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/longrun
```

While you change it, clone the SDK and link the folder instead, so Tern
reloads it on every save:

```sh
git clone https://github.com/stencil-hq/tern-sdk
tern plugin link tern-sdk/plugins/examples/longrun
```

The timings come from shell integration's prompt marks, so panes need it on
(the default). Run `sleep 20` and wait for the toast, then press
`cmd+alt+shift+l` (`ctrl+alt+shift+l` off macOS) to see the block.

## Design

### Why the work is on the host

The daemon measures each command itself: when a shell reports that a
command line ended, the daemon emits `command_finished` with the exit
status and `took_ms`, the time since the matching `command_started`. Both
halves can hear these events, and `longrun` deliberately records them on
the host:

| Concern | Host half | Window half |
| --- | --- | --- |
| Panes it hears | Every pane of the daemon, including sessions no window shows | Only the panes of its own window, and only while the window is open |
| `tern.kv` writers | One VM per daemon | One VM per window, so one history entry would be written once per open window |
| Command directory | `command_started` carries `cwd` | No `cwd` on the event |

A build that finishes in a session whose window was closed still lands in
the history, and the toast reaches every window of that pane's window key
when one is open. The window half only does what needs a window: the
command, the key and the status segment. It hears the same events for its
own panes, which is all the segment needs.

### Deciding what is slow

`command_finished` compares `took_ms` with the threshold, read from kv
`threshold_ms` on every event so the block's `+` and `-` keys take effect
at once. A few programs are excluded: an editor, pager, `ssh` session or
REPL runs exactly as long as you use it, and a toast saying "vim finished
in 41m" is noise. `common.interactive` finds the program a command line
runs (skipping `VAR=value` prefixes and wrappers such as `sudo`, `env` and
`time`) and checks it against a list. Interpreters count as interactive only
without a script: `python` is a prompt, `python train.py` is a job.

Durations are written the way people say them: `8.4s` under ten seconds,
`42s`, `1m 12s`, `2h 5m`. A failure toasts with the error tone and puts the
exit status first in the secondary line.

### The history

The history is a Lua array read from kv once, when the host half loads,
and written back whole after every change. Each record keeps the command
line, its directory, `took_ms`, the exit status and `os.time()` at the end,
so the block can show "14:02" for today and "Mar 03 14:02" otherwise. The
newest record is first and the array is trimmed to 50, which keeps
`kv.json` small: kv rewrites the whole file on every `set`.

The `cwd` comes from the `command_started` the hook saw for that pane. When
the plugin loaded mid-command there is none, and `tern.pane.list()` supplies
the pane's current directory instead.

### The block and its clock

The Slow Commands block has two parts: "Running now", the commands at
least a second old with their elapsed times, and the history table. Its
title counts the history ("Slow Commands (12)").

Elapsed times must move, but Tern runs a block's `view` only after one of
its handlers (`init`, `key`, `event`, `resize`), a resize of its pane or a
`cx:render()` call.
The host keeps every open block's `BlockCx` from `init` (a block's `cx`
outlives the call that received it), and `schedule()` arms a one-second
`tern.timer` only while at least one
block is open and at least one command runs. The timer re-renders the
blocks and schedules itself again. Completion or shell exit cancels the
tick immediately when the last command ends; the next tick prunes closed
blocks and stops if none remain. `longrun` runs no timer while nothing is
running.

History and threshold changes call `refresh()` too: clearing in one block
updates every other open block's history and count, and changing the
threshold updates all their labels even when no command runs and no timer
is scheduled. Each view clamps its own selection to the current history.

Plugin blocks get no close callback. `prune()` drops a block whose pane is
no longer in `tern.pane.list()`, but only after two seconds, because `init`
can run before the daemon lists the new pane.

Keys follow the list conventions: `↑`/`↓` or `j`/`k` select, `Enter`
copies the selected command line, `c` clears the history and `+`/`-`
change the threshold by five seconds. The dock repeats the keys and offers
Copy and Clear badges, whose `actions.click` names arrive in the block's
`event` handler as `{ev = "action", act = ...}`. The `key` handler returns
`true` for every key it acts on and `false` for the rest: an exact `false`
tells Tern the key changed nothing, so it skips the render and the save.

### Opening the block

"Show slow commands" first looks for a pane in this window whose title
starts with "Slow Commands" and focuses it; otherwise
`cx:new_block("longrun.slow", nil, "tab")` opens one. `new_block` returns
`nil` when no loaded plugin on the pane's host defines the kind, for
example a window attached to a remote host where `longrun` isn't
installed, and the command toasts that instead of failing silently.

The manifest sets `palette = false` on the block, so the palette shows only
the command, not a second "New Slow Commands block" row.

### A status segment that ticks

While the focused pane runs a command, the status line shows its program
and how long it has been running, "cargo · 1m 12s", counting up; clicking
it runs `plugin.longrun.show`, which opens the block.

The window half keeps its own `running` table from the window's
`command_started` and `command_finished` events: the program
(`common.program`, so `FOO=1 cargo build` shows `cargo`) and `tern.now()`
at the start. Interactive programs are left out, as in the history. It
refreshes focus with `cx.session:focused()` on every relevant window event,
including `command_started`, rather than relying on a startup event.
Plugin reload can preserve the same focused pane without emitting
`window_start` or `focus`; the next command still starts the clock.

A status formatter is called with `{pane, cwd, program, title, busy}` and
Tern caches its answer per input, but the running time depends on the
clock, which is not part of the input. The segment stays current as follows:

- `schedule()` arms exactly one one-second `tern.timer` while the focused
  pane has an observed running command. The callback receives a fresh
  `WindowCx`; it refreshes focus and checks `cx.session:panes()`, dropping
  runs for absent panes or those whose `busy` snapshot is false. It then
  calls `tern.chrome.refresh()` even if the run ended, erasing the last
  cached segment, and schedules again only if the focused command is live.
- A shell that exits without supplying its next prompt mark may emit no
  window `command_finished`. Its snapshot still becomes idle. The next
  tick detects that and stops; the formatter also immediately hides an
  idle pane's segment when its `busy` input changes. This works even when
  the program and title are unchanged.
- Command completion, pane closure and focus changes reconcile snapshots
  and cancel any unneeded tick immediately. Command start/finish and pane
  closure invalidate chrome, so an earlier run's cached time never shows.
  Focusing an observed running pane starts its clock again.

Contexts are never retained across callbacks. Only live focused commands
drive snapshot checks: an idle window runs no timer, including after a
reload, and the same snapshots work for remote panes.

The formatter returns nothing during a command's first second, so quick
commands don't flash a segment, and writes whole seconds under a minute
(`42s`), then `common.duration`'s `1m 12s` and `2h 5m`. See
[Chrome and Styling](../guides/chrome.md#refreshing) for the rules.

## Limits

- Panes without shell integration report no commands, so nothing is timed.
- The segment times only commands the window half saw start: one already
  running when the window opened or the plugin reloaded shows no segment
  until the next command.
- The history and threshold belong to the daemon's machine
  (`<state>/plugin-data/longrun/kv.json`).

## Code

`plugin.toml`:

```toml
schema = 1
id = "longrun"
name = "Long-Running Commands"
version = "0.1.0"
description = "Toasts when a slow command finishes and lists recent slow commands."
icon = "clock"
host = "host.luau"
window = "window.luau"

[[blocks]]
id = "slow"
title = "Slow Commands"
# The window half's "Show slow commands" command opens it.
palette = false
```

`common.luau`, required by both halves:

```lua
--!strict
-- Helpers both halves of longrun require: reading a command line's program
-- and writing durations the way people say them.

local common = {}

-- Words that run another program: the program is the next word.
local WRAPPERS: { [string]: boolean } = {
	sudo = true,
	env = true,
	time = true,
	nice = true,
	nohup = true,
	command = true,
	exec = true,
	caffeinate = true,
}

-- Programs that stay open until you leave them. Their run time measures how
-- long you used them, not how long you waited, so they are never "slow".
common.INTERACTIVE = {
	vi = true,
	vim = true,
	nvim = true,
	hx = true,
	nano = true,
	emacs = true,
	less = true,
	more = true,
	man = true,
	ssh = true,
	mosh = true,
	tmux = true,
	screen = true,
	top = true,
	htop = true,
	btop = true,
	watch = true,
	fzf = true,
	lazygit = true,
	tig = true,
	ipython = true,
	psql = true,
	mysql = true,
	sqlite3 = true,
	["redis-cli"] = true,
	omp = true,
}

-- Interpreters that are a prompt when run bare and a job when given a
-- script: `python` waits for you, `python train.py` makes you wait.
local REPLS: { [string]: boolean } = {
	python = true,
	python3 = true,
	node = true,
	irb = true,
	lua = true,
}

-- The program a command line runs (the first word that is not a
-- `VAR=value` prefix, a wrapper or a wrapper's flag, without its
-- directory), and whether more words follow it.
function common.program(line: string): (string?, boolean)
	local at = 1
	while true do
		local from, to, word = string.find(line, "(%S+)", at)
		if from == nil then
			return nil, false
		end
		local w = word :: string
		local assignment = string.find(w, "^[%a_][%w_]*=") ~= nil
		local flag = string.sub(w, 1, 1) == "-"
		if not assignment and not flag and not WRAPPERS[w] then
			local rest = string.sub(line, (to :: number) + 1)
			return string.match(w, "([^/]+)$"), string.find(rest, "%S") ~= nil
		end
		at = (to :: number) + 1
	end
end

-- Whether `line` runs a program you use rather than wait for: one
-- `INTERACTIVE` lists, or a bare interpreter.
function common.interactive(line: string): boolean
	local program, args = common.program(line)
	if program == nil then
		return false
	end
	return common.INTERACTIVE[program] == true or (REPLS[program] == true and not args)
end

-- `ms` as "8.4s", "42s", "1m 12s" or "2h 5m".
function common.duration(ms: number): string
	if ms < 10000 then
		return string.format("%.1fs", ms / 1000)
	end
	local seconds = math.floor(ms / 1000)
	if seconds < 60 then
		return string.format("%ds", seconds)
	end
	local minutes = seconds // 60
	if minutes < 60 then
		return string.format("%dm %ds", minutes, seconds % 60)
	end
	return string.format("%dh %dm", minutes // 60, minutes % 60)
end

-- `path` with the home directory written `~`.
function common.tilde(path: string, home: string?): string
	if home and home ~= "" then
		if path == home then
			return "~"
		end
		if string.sub(path, 1, #home + 1) == home .. "/" then
			return "~" .. string.sub(path, #home + 1)
		end
	end
	return path
end

-- `text` cut to `max` characters, the last one an ellipsis.
function common.clip(text: string, max: number): string
	local length = utf8.len(text)
	if length == nil then -- not UTF-8: count bytes
		return if #text <= max then text else string.sub(text, 1, max - 1) .. "…"
	end
	if length <= max then
		return text
	end
	local cut = utf8.offset(text, max) or (#text + 1)
	return string.sub(text, 1, cut - 1) .. "…"
end

return common
```

`host.luau`:

```lua
--!strict
-- longrun, host half: a `command_finished` hook that toasts when a command
-- took longer than the threshold and keeps the last 50 such commands in
-- `tern.kv`, and the "Slow Commands" block that lists them beside the
-- commands running right now.

local common = require("./common")
local ui = tern.ui

local DEFAULT_THRESHOLD_MS = 15000
local STEP_MS = 5000
local KEEP = 50
local HOME = tern.getenv("HOME")

-- A finished slow command, as stored under kv `history` (newest first).
type Record = {
	line: string,
	cwd: string?,
	took_ms: number,
	status: number,
	at: number, -- os.time() when it finished
}

-- A command a shell is running now.
type Run = {
	line: string,
	cwd: string?,
	started: number, -- tern.now() when it started
}

-- An open Slow Commands block.
type Open = {
	cx: BlockCx,
	since: number,
}

type State = {
	selected: number,
}

local function threshold(): number
	local value = tern.kv.get("threshold_ms")
	return if type(value) == "number" and value > 0 then value else DEFAULT_THRESHOLD_MS
end

-- The history, read once; every change writes it back.
local slow: { Record } = tern.kv.get("history") or {}
-- Commands running now, by pane.
local running: { [number]: Run } = {}
-- Open blocks, by pane.
local blocks: { [number]: Open } = {}
-- The pending re-render tick, while one is scheduled.
local tick: TimerHandle? = nil

local function cwd_of(pane: number): string?
	for _, info in tern.pane.list() do
		if info.pane == pane then
			return info.cwd
		end
	end
	return nil
end

-- Drops blocks whose pane is gone. A block registers in `init`, which can
-- run before the daemon lists its pane, so young entries are kept.
local function prune()
	local live: { [number]: boolean } = {}
	for _, info in tern.pane.list() do
		live[info.pane] = true
	end
	local now = tern.now()
	for pane, open in blocks do
		if not live[pane] and now - open.since > 2000 then
			blocks[pane] = nil
		end
	end
end

-- Re-renders every open block.
local function refresh()
	prune()
	for _, open in blocks do
		open.cx:render()
	end
end

-- Ticks once a second while a block is open and a command runs, so the
-- elapsed times move; stops by itself when either is no longer true.
local function schedule()
	if next(running) == nil or next(blocks) == nil then
		if tick ~= nil then
			tick:cancel()
			tick = nil
		end
		return
	end
	if tick ~= nil then
		return
	end
	tick = tern.timer(1000, function()
		tick = nil
		refresh()
		schedule()
	end)
end

local function remember(record: Record)
	table.insert(slow, 1, record)
	while #slow > KEEP do
		table.remove(slow)
	end
	tern.kv.set("history", slow)
end

tern.on("command_started", function(ev: CommandStartedEvent, _cx: EffectCx)
	running[ev.pane] = { line = ev.line, cwd = ev.cwd, started = tern.now() }
	schedule()
end)

tern.on("command_finished", function(ev: CommandFinishedEvent, cx: EffectCx)
	local run = running[ev.pane]
	running[ev.pane] = nil
	if ev.took_ms >= threshold() and not common.interactive(ev.line) then
		local cwd = if run then run.cwd else cwd_of(ev.pane)
		remember({ line = ev.line, cwd = cwd, took_ms = ev.took_ms, status = ev.status, at = os.time() })
		local line = common.clip(ev.line, 60)
		local took = common.duration(ev.took_ms)
		local where = if cwd then common.tilde(cwd, HOME) else nil
		if ev.status == 0 then
			cx:toast("success", string.format("%s finished in %s", line, took), where)
		else
			local sub = string.format("exit %d", ev.status) .. (if where then " · " .. where else "")
			cx:toast("error", string.format("%s failed after %s", line, took), sub)
		end
	end
	refresh()
	schedule()
end)

tern.on("pane_exited", function(ev: PaneExitedEvent, _cx: EffectCx)
	running[ev.pane] = nil
	refresh()
	schedule()
end)

-- Block views.

local function badge(text: string, tone: string, action: string): Node
	local node = ui.badge(text, tone)
	local props: { [string]: any } = node.p or {}
	props.actions = { click = action }
	node.p = props
	return node
end

local function when(at: number): string
	if os.date("%Y-%m-%d", at) == os.date("%Y-%m-%d") then
		return os.date("%H:%M", at)
	end
	return os.date("%b %d %H:%M", at)
end

local function running_view(): Node?
	local now = tern.now()
	local runs: { Run } = {}
	for _, run in running do
		-- Under a second is noise; interactive programs aren't waits.
		if now - run.started >= 1000 and not common.interactive(run.line) then
			table.insert(runs, run)
		end
	end
	if #runs == 0 then
		return nil
	end
	table.sort(runs, function(a: Run, b: Run)
		return a.started < b.started
	end)
	local rows = {}
	for _, run in runs do
		table.insert(rows, {
			{ ui.span(run.line, "mono") },
			{ ui.span(if run.cwd then common.tilde(run.cwd, HOME) else "", "muted") },
			{ ui.span(common.duration(now - run.started), "num accent") },
		})
	end
	local cols: { Col } = {
		{ id = "command", head = "Command", grow = 1 },
		{ id = "cwd", head = "Directory", truncate = "start", priority = -1 },
		{ id = "elapsed", head = "Running", align = "end" },
	}
	return ui.section("Running now", { ui.table(cols, rows) })
end

local function history_view(state: State): Node
	if #slow == 0 then
		return ui.text({
			ui.span(string.format("No command has taken %s or longer yet.", common.duration(threshold())), "muted"),
		})
	end
	local rows = {}
	for i, record in slow do
		local mark = if i == state.selected then ui.span("›", "accent strong") else ""
		local status = if record.status == 0
			then ui.span("ok", "success")
			else ui.span(string.format("exit %d", record.status), "error")
		table.insert(rows, {
			{ mark },
			{ ui.span(record.line, if i == state.selected then "mono strong" else "mono") },
			{ ui.span(if record.cwd then common.tilde(record.cwd, HOME) else "", "muted") },
			{ ui.span(common.duration(record.took_ms), "num") },
			{ status },
			{ ui.span(when(record.at), "muted num") },
		})
	end
	local cols: { Col } = {
		{ id = "mark", head = "" },
		{ id = "command", head = "Command", grow = 1 },
		{ id = "cwd", head = "Directory", truncate = "start", priority = -1 },
		{ id = "took", head = "Took", align = "end" },
		{ id = "status", head = "Status" },
		{ id = "when", head = "When", align = "end", priority = -2 },
	}
	return ui.table(cols, rows)
end

local function dock(): Node
	return ui.row({
		ui.text({
			ui.span("↑↓", "strong"),
			ui.span(" select  ", "muted"),
			ui.span("⏎", "strong"),
			ui.span(" copy  ", "muted"),
			ui.span("c", "strong"),
			ui.span(" clear  ", "muted"),
			ui.span("+ −", "strong"),
			ui.span(string.format(" threshold %s", common.duration(threshold())), "muted"),
		}),
		badge("Copy", "accent", "copy"),
		badge("Clear", "muted", "clear"),
	})
end

local function copy(state: State, cx: BlockCx)
	local record = slow[state.selected]
	if record then
		cx:copy(record.line)
		cx:toast("info", "Copied", common.clip(record.line, 60))
	end
end

local function clear(state: State)
	table.clear(slow)
	tern.kv.set("history", nil)
	state.selected = 1
	refresh()
end

local function nudge(delta: number)
	local value = math.max(STEP_MS, threshold() + delta)
	tern.kv.set("threshold_ms", value)
	refresh()
end

tern.block.define("slow", {
	init = function(cx: BlockCx, _args: { string }, _saved: any): State
		blocks[cx.pane] = { cx = cx, since = tern.now() }
		schedule()
		return { selected = 1 }
	end,
	title = function(_state: State): string?
		return if #slow > 0 then string.format("Slow Commands (%d)", #slow) else "Slow Commands"
	end,
	view = function(state: State, _cx: BlockCx): BlockView
		state.selected = math.clamp(state.selected, 1, math.max(1, #slow))
		local parts: { Node } = {}
		local now = running_view()
		if now then
			table.insert(parts, now)
		end
		table.insert(parts, history_view(state))
		return { main = ui.col(parts), dock = dock() }
	end,
	key = function(state: State, key: Key, cx: BlockCx): boolean?
		local press = key.text or key.name
		if key.name == "up" or press == "k" then
			state.selected = math.max(1, state.selected - 1)
		elseif key.name == "down" or press == "j" then
			state.selected = math.min(math.max(1, #slow), state.selected + 1)
		elseif key.name == "enter" then
			copy(state, cx)
		elseif press == "c" then
			clear(state)
		elseif press == "+" or press == "=" then
			nudge(STEP_MS)
		elseif press == "-" then
			nudge(-STEP_MS)
		else
			return false
		end
		return true
	end,
	event = function(state: State, ev: UiEvent, cx: BlockCx)
		if ev.ev ~= "action" then
			return
		end
		if ev.act == "copy" then
			copy(state, cx)
		elseif ev.act == "clear" then
			clear(state)
		end
	end,
})
```

`window.luau`:

```lua
--!strict
-- longrun, window half: the "Show slow commands" command and its key, and a
-- status line segment with the focused pane's running command and how long
-- it has been running, ticking once a second.

local common = require("./common")

local BLOCK = "longrun.slow"
local ACTION = "plugin.longrun.show"
-- The segment appears once a command has run this long, so quick commands
-- don't flash it.
local SHOW_AFTER_MS = 1000

-- A command running in one of this window's panes.
type Run = {
	program: string,
	started: number, -- tern.now() when it started
}

-- Commands running now, by pane. Only commands this window half saw start:
-- one already running when the plugin loaded has no entry.
local running: { [number]: Run } = {}
-- The focused pane, refreshed from the current session on events and ticks.
local focused: number? = nil
-- The pending tick, while one is scheduled.
local tick: TimerHandle? = nil

local function show(cx: WindowCx)
	-- Focus a Slow Commands block this window already shows, else open one.
	for _, pane in cx.session:panes() do
		if string.find(pane.title, "^Slow Commands") then
			cx.layout:focus(pane.pane)
			return
		end
	end
	if cx:new_block(BLOCK, nil, "tab") == nil then
		cx:toast("error", "Slow Commands is unavailable", "The longrun host half isn't loaded on this host.")
	end
end

tern.command({
	id = "show",
	title = "Show slow commands",
	icon = "clock",
	run = show,
})

tern.bind(if tern.runtime.os == "macos" then "cmd+alt+shift+l" else "ctrl+alt+shift+l", ACTION)

-- A reload need not emit window_start or focus. Every event and timer gets
-- a fresh context; never retain one. Snapshots also detect shell exits that
-- supplied no command_finished prompt mark.
local function reconcile(cx: WindowCx)
	focused = cx.session:focused()
	local busy: { [number]: boolean } = {}
	for _, pane in cx.session:panes() do
		busy[pane.pane] = pane.busy
	end
	for pane in running do
		if not busy[pane] then
			running[pane] = nil
		end
	end
end

-- Exactly one timer while the focused pane has an observed running command.
local function schedule()
	if focused == nil or running[focused :: number] == nil then
		if tick ~= nil then
			tick:cancel()
			tick = nil
		end
		return
	end
	if tick ~= nil then
		return
	end
	tick = tern.timer(1000, function(cx: WindowCx?)
		tick = nil
		reconcile(cx :: WindowCx)
		-- Refresh even when reconciliation removed the run, to erase its
		-- last cached segment before stopping the clock.
		tern.chrome.refresh()
		schedule()
	end)
end

tern.on("window_start", function(cx: WindowCx)
	reconcile(cx)
	schedule()
end)

tern.on("focus", function(_ev: FocusEvent, cx: WindowCx)
	reconcile(cx)
	schedule()
end)

tern.on("command_started", function(ev: CommandStartedEvent, cx: WindowCx)
	reconcile(cx)
	if not common.interactive(ev.line) then
		running[ev.pane] = { program = common.program(ev.line) or ev.line, started = tern.now() }
	end
	-- Drop any cached answer from an earlier run with the same input.
	tern.chrome.refresh()
	schedule()
end)

tern.on("command_finished", function(ev: CommandFinishedEvent, cx: WindowCx)
	running[ev.pane] = nil
	reconcile(cx)
	tern.chrome.refresh()
	schedule()
end)

tern.on("pane_closed", function(ev: PaneEvent, cx: WindowCx)
	running[ev.pane] = nil
	reconcile(cx)
	tern.chrome.refresh()
	schedule()
end)

-- Whole seconds under a minute, then as `common.duration` writes them.
local function elapsed(ms: number): string
	if ms < 60000 then
		return string.format("%ds", ms // 1000)
	end
	return common.duration(ms)
end

-- The formatter's answer depends on the clock, which is not part of its
-- input ({pane, cwd, program, title, busy}), so Tern would keep showing its first
-- answer: the timer above calls `tern.chrome.refresh()` to drop it.
tern.chrome.status(function(pane: PaneInfo): { StatusSegment }?
	-- busy changes the formatter input even if program/title happen to stay
	-- identical (for example a command that runs the login shell itself).
	if not pane.busy then
		running[pane.pane] = nil
		schedule()
		return nil
	end
	local run = running[pane.pane]
	if run == nil then
		return nil
	end
	local ms = tern.now() - run.started
	if ms < SHOW_AFTER_MS then
		return nil
	end
	return {
		{
			text = string.format("%s · %s", run.program, elapsed(ms)),
			icon = "clock",
			tone = "muted",
			command = ACTION,
		},
	}
end)
```
