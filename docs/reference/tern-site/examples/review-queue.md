# Review Queue

`review-queue` keeps the pull requests that wait for your review in a
block: it runs the GitHub CLI's `gh search prs --review-requested=@me`
every two minutes and lists the results with their repository, title,
author, age and draft state. It is the example for a long-lived block fed
by a background process, and for a window command that opens a block.

## What it demonstrates

| Surface | Half | Used for |
| --- | --- | --- |
| `tern.block.define` with `init`, `title`, `view`, `key`, `event`, `save` | Host | The Review Queue block |
| `tern.process.run` with `timeout_ms` and `env` | Host | Running `gh` off the worker thread |
| `tern.timer`, `TimerHandle:cancel`, `BlockCx:render`, `tern.pane.list` | Host | One polling chain per block run, retired on restart or close |
| `tern.json.decode` | Host | Reading `gh`'s JSON |
| `ui.list` with `selected`, `max` and keyed items | Host | The list, its cursor and click events |
| `ui.card`, `ui.md`, `ui.code`, badge `actions` | Host | Error views with Retry and Install buttons |
| `BlockCx:open` | Host | Opening a pull request in the browser |
| `save` and `init`'s `saved` | Host | Remembering whether drafts show |
| `tern.command`, `tern.bind` | Window | "Open review queue" and its key |
| `cx.session:panes()`, `cx.layout:focus`, `cx:new_block` | Window | Focusing the open queue, or opening one |

## Install

The block runs `gh` on the machine that runs your panes (the daemon's
host), so install the [GitHub CLI](https://cli.github.com) there and sign
in with `gh auth login`. Then:

```sh
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/review-queue
```

While you change it, clone the SDK and link the folder instead, so Tern
reloads it on every save:

```sh
git clone https://github.com/stencil-hq/tern-sdk
tern plugin link tern-sdk/plugins/examples/review-queue
```

Press `alt+shift+cmd+r`, or run **Open review queue** from the palette.

## Design

### Running `gh` without blocking

Every call into a host plugin runs on its worker with a 2-second budget,
and a GitHub search can take longer than that. `tern.process.run` starts
the program on a pool thread and returns at once; its callback runs later
on the worker with the result. The block shows a progress bar until the
first answer arrives. Each callback first checks that its state still
belongs to the current run of the block, then ends with `state.cx:render()`,
because Tern only re-runs `view` by itself after a handler.

```lua
tern.process.run(argv, opts, function(result: ProcessResult, _)
	done(result)
end)
```

The options matter for a program started by a daemon:

| Option | Why |
| --- | --- |
| `timeout_ms = 30000` | A hung network call ends as `timed_out` instead of leaving the block "refreshing" forever |
| `GH_PROMPT_DISABLED=1` | `gh` never waits for an answer on a terminal it doesn't have |
| `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1` | stderr stays a plain error message the block can show |

A daemon started by launchd or systemd often has a short `PATH`. The block
tries `gh` by name first, then the usual install locations
(`/opt/homebrew/bin`, `/usr/local/bin`, Linuxbrew, `/usr/bin`) that exist
on disk. `tern.process.run` raises when the program cannot be spawned, so
each attempt runs under `pcall`, and only when all of them fail does the
block report that `gh` is missing.

### Polling, and stopping

`init` registers its state in a `running` table keyed by pane ID, starts
the first refresh, and stores a 2-minute `tern.timer` handle. Restart keeps
the same pane ID, so pane existence alone is not a lifetime check: the
state object must also match `running[state.cx.pane]`.

A replacement `init` retires the previous state before registering the new
one: it cancels only the old state's timer and releases its PR list. Every
refresh, process callback and timer callback checks that state identity.
A stale callback cannot update the list, render, start another request, or
rearm a timer; it cannot remove or cancel the replacement's state or timer.

Plugin blocks get no close callback, so a live callback also checks
`tern.pane.list()`. A disappeared pane retires its state and cancels its
pending timer. With no process pending, that cleanup happens at the next
2-minute tick. Already-started processes have no cancellation handle in
this API: they finish or hit the existing 30-second timeout, and their
stale results are ignored.

The timer clears its handle before refreshing and arming the next one,
keeping one pending timer per current run. A `loading` flag keeps manual
refresh (`r`, Retry) from starting a second `gh` while one is running.

### Telling failures apart

A failed run becomes a `Problem` with one of three kinds, each with its
own heading and advice:

| Kind | Detected by | The view says |
| --- | --- | --- |
| `missing` | No candidate `gh` could be spawned | "GitHub CLI not found", with an Install guide button |
| `auth` | Exit status 4 (`gh`'s "authentication required"), or stderr mentioning `gh auth login`, `GH_TOKEN` or HTTP 401 | "GitHub CLI not signed in": run `gh auth login`, then press `r` |
| `failed` | Anything else, including a timeout or JSON that isn't a list | "Could not load review requests", with the first lines of stderr |

Before the first successful load, the problem fills the block as a card
with Retry (and, for `missing`, Install guide) buttons. After a list has
loaded once, a later failure keeps the last list on screen and adds the
problem to the dock, since stale data with a warning is more useful than
an error page during a short outage.

### The list

`ui.list` draws the rows; the block then gives every item a `key` of
`owner/repo#number` and the list itself the key `queue`. Node ids are
built from keys, so each row's id is `main.queue.<owner/repo#number>` no
matter how the list reorders on the next poll. That id is what the list's
`selected` prop names and what its `select` (click) and `activate` (double
click) events carry in `ev.item`, so the cursor follows a pull request,
not a position. When the selected pull request disappears, the cursor
moves to the first row.

Two details of how blocks are drawn shape the view:

- A region draws the children of the node `view` returns, not that node
  itself. A list returned directly as `main` would lose its selection and
  events, so `main` is always `ui.col({ … })` around the list, card or
  progress bar.
- A list keeps its selected row in view only when it scrolls itself, which
  it does once it has a `max` height. The block sets
  `max = { lines = … }` from `cx.rows`. It needs no `resize` handler:
  Tern runs `view` again when the pane resizes, and the height follows.

Rows put the repository and number before the title in the label, and the
author and age in the right-aligned value. A list item's `detail` takes
only the space the label leaves, so a long title would hide anything
placed there. Drafts start with a `draft` marker and the muted tone.

The `age` column needs the pull request's creation time as a Unix time.
`gh` prints ISO 8601 in UTC, and Luau's `os.time` with a table reads local
time, so `epoch` converts the date with the days-from-civil algorithm.

### Keys and saved state

| Key | Action |
| --- | --- |
| `↑`/`↓`, `k`/`j` | Move |
| `PageUp`/`PageDown`, `Home`/`End`, `g`/`G` | Jump |
| `Enter`, `o` | Open the pull request (`cx:open(url)`) |
| `r` | Refresh now |
| `d` | Show or hide drafts |

The handler ignores keys with Ctrl, Alt or Cmd held, and returns `false`
for keys it doesn't use, so they cost no render and no save; every key it
acts on returns `true`.

Whether drafts show is the block's only saved state: `save` returns
`{drafts = …}` and `init` reads it back from `saved` after a restart. Tern
runs `save` after every handler and stores the result only when it
changed, so the block never calls `cx:save()` itself.

### The window half

The window half adds one palette command and binds it:

```lua
tern.command({ id = "open", title = "Open review queue", icon = "merge", run = open_queue })
tern.bind("alt+shift+cmd+r", "plugin.review-queue.open")
```

Each open queue polls GitHub, so `open_queue` first looks through
`cx.session:panes()` for a pane titled "Review Queue…" and focuses it.
Otherwise `cx:new_block("review-queue.queue", nil, "beside")` opens one
next to the focused pane. `new_block` returns `nil` when the host that
runs the window's panes has no such block type (the plugin is installed
in this window's machine but not on a remote host it is attached to), and
the command says so in a toast. A plugin bind whose chord the keyboard
preset already uses is left out with a warning in the log; see
[Commands, Keys, and Overrides](../guides/commands.md).

## Limits

- The search asks for at most 100 results (`--limit=100`).
- A new review request shows up at the next poll, up to two minutes later,
  or at once with `r`.
- Every open queue polls on its own; the command keeps it to one per
  window, but other windows can open their own.

## Code

`plugin.toml`:

```toml
schema = 1
id = "review-queue"
name = "Review Queue"
version = "1.0.0"
description = "Pull requests waiting for your review, from the GitHub CLI."
icon = "merge"
host = "host.luau"
window = "window.luau"

[[blocks]]
id = "queue"
title = "Review Queue"
```

`host.luau`:

```lua
--!strict
-- The `queue` block: open pull requests that request your review, read from
-- `gh search prs` and refreshed every two minutes.
--
-- Keys: ↑/↓ (or k/j) move, Home/End jump, Enter (or o) opens the pull
-- request, r refreshes, d shows or hides drafts.

local ui = tern.ui

local POLL_MS = 2 * 60 * 1000
local GH_TIMEOUT_MS = 30 * 1000
local INSTALL_URL = "https://cli.github.com"

local SEARCH = {
	"search",
	"prs",
	"--review-requested=@me",
	"--state=open",
	"--limit=100",
	"--json=number,title,url,repository,author,createdAt,isDraft",
}

-- `gh` by name first, then where package managers put it: a daemon started
-- by launchd or systemd often has a PATH without those directories.
local GH = {
	"gh",
	"/opt/homebrew/bin/gh",
	"/usr/local/bin/gh",
	"/home/linuxbrew/.linuxbrew/bin/gh",
	"/usr/bin/gh",
}

type Pr = {
	key: string,
	repo: string,
	number: number,
	title: string,
	author: string,
	url: string,
	created: number,
	draft: boolean,
}

-- Why the list could not be loaded: `missing` (no gh), `auth` (gh is not
-- signed in) or `failed` (anything else).
type Problem = { kind: string, text: string, detail: string? }

type State = {
	cx: BlockCx,
	prs: { Pr }?,
	shown: { Pr },
	cursor: string?,
	drafts: boolean,
	loading: boolean,
	fetched: number?,
	problem: Problem?,
	timer: TimerHandle?,
}

-- A pane ID survives Restart; the state object identifies this block run.
local running: { [number]: State } = {}

local function retire(state: State)
	if running[state.cx.pane] == state then
		running[state.cx.pane] = nil
	end
	if state.timer then
		state.timer:cancel()
		state.timer = nil
	end
	-- A pending process may retain its callback until the 30-second timeout.
	-- Release the old list now; its callback must not populate it again.
	state.loading = false
	state.prs = nil
	state.shown = {}
	state.cursor = nil
	state.problem = nil
	state.fetched = nil
end

-- Seconds since the epoch of an ISO 8601 UTC time (`2026-09-30T14:03:11Z`),
-- by the days-from-civil algorithm: `os.time` with a table reads local time.
local function epoch(iso: string): number?
	local y, m, d, hh, mm, ss = string.match(iso, "^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
	if not (y and m and d and hh and mm and ss) then
		return nil
	end
	local year, month, day = tonumber(y) :: number, tonumber(m) :: number, tonumber(d) :: number
	if month <= 2 then
		year -= 1
	end
	local era = year // 400
	local yoe = year - era * 400
	local doy = (153 * (if month > 2 then month - 3 else month + 9) + 2) // 5 + day - 1
	local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
	local days = era * 146097 + doe - 719468
	return days * 86400 + (tonumber(hh) :: number) * 3600 + (tonumber(mm) :: number) * 60 + (tonumber(ss) :: number)
end

-- How long ago `t` was, compactly: `12m`, `5h`, `3d`.
local function age(t: number): string
	local s = math.max(0, os.time() - t)
	if s < 3600 then
		return math.max(1, s // 60) .. "m"
	elseif s < 86400 then
		return s // 3600 .. "h"
	end
	return s // 86400 .. "d"
end

-- Check this run first, not just its pane: Restart reuses the pane ID.
-- Blocks have no close hook, so callbacks also retire a disappeared pane.
local function alive(state: State): boolean
	if running[state.cx.pane] ~= state then
		return false
	end
	for _, p in tern.pane.list() do
		if p.pane == state.cx.pane then
			return true
		end
	end
	retire(state)
	return false
end

-- The pull requests the list shows, oldest first, and a cursor on one of them.
local function refilter(state: State)
	local shown: { Pr } = {}
	local prs: { Pr } = state.prs or {}
	for _, pr in prs do
		if state.drafts or not pr.draft then
			table.insert(shown, pr)
		end
	end
	table.sort(shown, function(a, b)
		return a.created < b.created
	end)
	state.shown = shown
	local found = false
	for _, pr in shown do
		found = found or pr.key == state.cursor
	end
	if not found then
		state.cursor = if shown[1] then shown[1].key else nil
	end
end

local function index_of(state: State): number
	for i, pr in state.shown do
		if pr.key == state.cursor then
			return i
		end
	end
	return 0
end

local function first_lines(text: string, n: number): string
	local out = {}
	for line in string.gmatch(text, "[^\n]+") do
		table.insert(out, line)
		if #out == n then
			break
		end
	end
	return table.concat(out, "\n")
end

-- What a failed `gh` run means.
local function problem_of(result: ProcessResult): Problem
	if result.timed_out then
		return { kind = "failed", text = "gh did not answer within 30 seconds." }
	end
	local err = result.stderr
	local auth = result.status == 4
		or string.find(err, "gh auth login", 1, true) ~= nil
		or string.find(err, "GH_TOKEN", 1, true) ~= nil
		or string.find(err, "HTTP 401", 1, true) ~= nil
	if auth then
		return { kind = "auth", text = "The GitHub CLI is not signed in.", detail = first_lines(err, 3) }
	end
	return {
		kind = "failed",
		text = "gh exited with status " .. result.status .. ".",
		detail = first_lines(err, 8),
	}
end

-- The pull requests in `gh`'s JSON, or nil when it isn't the expected list.
local function parse(stdout: string): { Pr }?
	local ok, data = pcall(tern.json.decode, stdout)
	if not ok or type(data) ~= "table" then
		return nil
	end
	local prs: { Pr } = {}
	for _, item in data do
		local repo = if type(item.repository) == "table" then item.repository.nameWithOwner else nil
		local number = tonumber(item.number)
		if type(repo) == "string" and number and type(item.url) == "string" then
			table.insert(prs, {
				key = repo .. "#" .. number,
				repo = repo,
				number = number,
				title = tostring(item.title or ""),
				author = if type(item.author) == "table" then tostring(item.author.login) else "?",
				url = item.url,
				created = epoch(tostring(item.createdAt or "")) or os.time(),
				draft = item.isDraft == true,
			})
		end
	end
	return prs
end

-- Starts `gh` with `args`, trying each place it may be installed; the spawn
-- error of the last attempt when none starts.
local function run_gh(args: { string }, done: (ProcessResult) -> ()): string?
	local last = "gh is not on this machine's PATH"
	for _, gh in GH do
		if gh == "gh" or tern.fs.exists(gh) then
			local argv: { string } = { gh }
			for _, a in args do
				table.insert(argv, a)
			end
			local opts: ProcessOptions = {
				timeout_ms = GH_TIMEOUT_MS,
				env = { GH_PROMPT_DISABLED = "1", GH_NO_UPDATE_NOTIFIER = "1", NO_COLOR = "1" },
			}
			local ok, err = pcall(function()
				tern.process.run(argv, opts, function(result: ProcessResult, _)
					done(result)
				end)
			end)
			if ok then
				return nil
			end
			last = tostring(err)
		end
	end
	return last
end

-- Loads the list in the background; the callback re-renders the block.
local function refresh(state: State)
	if not alive(state) or state.loading then
		return
	end
	state.loading = true
	local spawn_error = run_gh(SEARCH, function(result)
		if not alive(state) then
			return
		end
		state.loading = false
		if result.status ~= 0 then
			state.problem = problem_of(result)
		else
			local prs = parse(result.stdout)
			if prs then
				state.prs = prs
				state.problem = nil
				state.fetched = os.time()
				refilter(state)
			else
				state.problem = {
					kind = "failed",
					text = "gh printed something other than a list of pull requests.",
					detail = first_lines(result.stdout, 4),
				}
			end
		end
		state.cx:render()
	end)
	if spawn_error then
		state.loading = false
		state.problem = { kind = "missing", text = "Tern could not start the GitHub CLI.", detail = spawn_error }
	end
end

-- One pending timer per live run, canceled explicitly when it is replaced.
local function poll(state: State)
	if not alive(state) or state.timer then
		return
	end
	state.timer = tern.timer(POLL_MS, function()
		if not alive(state) then
			return
		end
		state.timer = nil
		refresh(state)
		state.cx:render()
		poll(state)
	end)
end

local function button(label: string, act: string, tone: string): Node
	local node = ui.badge(label, tone)
	local p: { [string]: any } = node.p or {}
	p.actions = { click = act }
	node.p = p
	return node
end

-- The full-pane view of a problem when there is no list to show.
local function problem_view(problem: Problem): Node
	local heads = {
		missing = "GitHub CLI not found",
		auth = "GitHub CLI not signed in",
		failed = "Could not load review requests",
	}
	local help = {
		missing = "Review Queue runs `gh search prs` on the machine that runs your panes. "
			.. "Install the GitHub CLI there, then press **r**.",
		auth = "Run `gh auth login` in a shell on this machine, then press **r**.",
		failed = "Press **r** to try again.",
	}
	local children: { Node } = { ui.md(problem.text .. " " .. (help[problem.kind] or "")) }
	if problem.detail and problem.detail ~= "" then
		table.insert(children, ui.code(problem.detail))
	end
	local buttons: { Node } = { button("Retry", "retry", "accent") }
	if problem.kind == "missing" then
		table.insert(buttons, button("Install guide", "install", "neutral"))
	end
	table.insert(children, ui.row(buttons))
	local card = ui.card({ ui.span(heads[problem.kind] or "Review Queue", "strong") }, children)
	local p: { [string]: any } = card.p or {}
	p.tone = "error"
	card.p = p
	return card
end

-- The list is keyed `queue`: its id is `main.queue` and each row's
-- `main.queue.<owner/repo#number>`, the ids `selected` and its events use.
local LIST_ID = "main.queue."

-- How many rows the list shows before it scrolls itself. A list with a
-- `max` height keeps its selected row in view; without one, `main` scrolls
-- and the cursor can leave the screen. List rows are about a third taller
-- than the pane's cells, and the dock takes about four cells.
local function list_lines(cx: BlockCx): number
	return math.max(4, math.floor((cx.rows - 4) * 0.72))
end

local function list_view(state: State): Node
	local items: { Item } = {}
	for _, pr in state.shown do
		-- A long title would squeeze out a `detail`, so the repository leads
		-- the label and the author sits in the right-aligned value.
		local label: { Span | string } = {}
		if pr.draft then
			table.insert(label, ui.span("draft  ", "warning"))
		end
		table.insert(label, ui.span(pr.repo .. "#" .. pr.number .. "  ", "muted"))
		table.insert(label, ui.span(pr.title))
		table.insert(items, {
			label = label,
			value = { ui.span("@" .. pr.author .. "  ", "muted"), ui.span(age(pr.created), "muted num") },
			icon = "merge",
			tone = if pr.draft then "muted" else nil,
		})
	end
	local list = ui.list(items)
	local kids = list.c or {}
	for i, pr in state.shown do
		local p: { [string]: any } = kids[i].p or {}
		p.key = pr.key
		kids[i].p = p
	end
	local p: { [string]: any } = list.p or {}
	p.key = "queue"
	p.selected = if state.cursor then LIST_ID .. state.cursor else nil
	p.empty = { ui.span("No pull requests are waiting for your review.", "muted") }
	p.max = { lines = list_lines(state.cx) }
	list.p = p
	return list
end

-- The dock: counts, freshness, a refresh problem, the keys.
local function dock_view(state: State): Node
	local total = if state.prs then #state.prs else 0
	local hidden = total - #state.shown
	local status: { Span | string } = { ui.span(#state.shown .. " to review", "strong") }
	if hidden > 0 then
		table.insert(status, ui.span("  " .. hidden .. " drafts hidden", "muted"))
	end
	if state.loading then
		table.insert(status, ui.span("  refreshing…", "muted"))
	elseif state.fetched then
		table.insert(status, ui.span("  updated " .. os.date("%H:%M", state.fetched), "muted"))
	end
	local lines: { Node } = { ui.text(status) }
	local problem = state.problem
	if problem then
		table.insert(lines, ui.text({ ui.span(problem.text, "warning"), ui.span("  showing the last list", "muted") }))
	end
	table.insert(
		lines,
		ui.text({
			ui.span("↑↓ move  ⏎ open  r refresh  d " .. (if state.drafts then "hide" else "show") .. " drafts", "dim"),
		})
	)
	return ui.col({ ui.lines(lines) })
end

local function open_selected(state: State, cx: BlockCx)
	local pr = state.shown[index_of(state)]
	if pr then
		cx:open(pr.url)
	end
end

local function move(state: State, to: number)
	local pr = state.shown[math.clamp(to, 1, math.max(1, #state.shown))]
	if pr then
		state.cursor = pr.key
	end
end

tern.block.define("queue", {
	init = function(cx: BlockCx, _args: { string }, saved: any): State
		local previous = running[cx.pane]
		if previous then
			retire(previous)
		end
		local state: State = {
			cx = cx,
			prs = nil,
			shown = {},
			cursor = nil,
			drafts = type(saved) == "table" and saved.drafts == true,
			loading = false,
			fetched = nil,
			problem = nil,
			timer = nil,
		}
		running[cx.pane] = state
		refresh(state)
		poll(state)
		return state
	end,

	title = function(state: State): string?
		if state.prs then
			return "Review Queue (" .. #state.shown .. ")"
		end
		return "Review Queue"
	end,

	view = function(state: State, _cx: BlockCx): BlockView
		local main: Node
		if state.prs then
			main = list_view(state)
		elseif state.problem then
			main = problem_view(state.problem)
		else
			main = ui.progress(nil, "Loading review requests…")
		end
		-- A region draws its root node's children, not the root itself (a
		-- list there would lose its selection and events), so the view
		-- sits inside a column.
		return { main = ui.col({ main }), dock = if state.prs then dock_view(state) else nil }
	end,

	key = function(state: State, key: Key, cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local i = index_of(state)
		local k = key.text or key.name
		if key.name == "up" or k == "k" then
			move(state, i - 1)
		elseif key.name == "down" or k == "j" then
			move(state, i + 1)
		elseif key.name == "page_up" then
			move(state, i - 10)
		elseif key.name == "page_down" then
			move(state, i + 10)
		elseif key.name == "home" or k == "g" then
			move(state, 1)
		elseif key.name == "end" or k == "G" then
			move(state, #state.shown)
		elseif key.name == "enter" or k == "o" then
			open_selected(state, cx)
		elseif k == "r" then
			refresh(state)
		elseif k == "d" then
			state.drafts = not state.drafts
			refilter(state)
		else
			return false
		end
		return true
	end,

	event = function(state: State, ev: UiEvent, cx: BlockCx)
		if ev.ev == "action" and ev.act == "retry" then
			refresh(state)
		elseif ev.ev == "action" and ev.act == "install" then
			cx:open(INSTALL_URL)
		elseif (ev.ev == "select" or ev.ev == "activate") and type(ev.item) == "string" then
			state.cursor = string.sub(ev.item, #LIST_ID + 1)
			if ev.ev == "activate" then
				open_selected(state, cx)
			end
		end
	end,

	save = function(state: State): any
		return { drafts = state.drafts }
	end,
})
```

`window.luau`:

```lua
--!strict
-- The window half: a palette command and a key bind that open the queue, or
-- focus the one already open in this window.

local KIND = "review-queue.queue"

local function open_queue(cx: WindowCx)
	-- One queue per window is enough: each open block polls GitHub.
	for _, pane in cx.session:panes() do
		if string.sub(pane.title, 1, #"Review Queue") == "Review Queue" then
			cx.layout:focus(pane.pane)
			return
		end
	end
	if cx:new_block(KIND, nil, "beside") == nil then
		cx:toast("error", "Review Queue is not loaded on this host", "Install the plugin where your panes run.")
	end
end

tern.command({
	id = "open",
	title = "Open review queue",
	icon = "merge",
	run = open_queue,
})

tern.bind("alt+shift+cmd+r", "plugin.review-queue.open")
```
