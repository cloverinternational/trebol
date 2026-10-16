# Host Hooks and the Spawn Filter

Host hooks let a plugin's host half react to what the machine's panes do:
a command starting or finishing, a directory or title change, a program
exiting. The spawn filter goes further and rewrites a shell's program,
arguments, directory and environment before it starts. This page covers the
events, what their handlers may do, the filter's contract, and where all of
this runs.

## Where hooks run

Hooks belong to the host half, which runs where the panes run:

- **With the session daemon** (the normal case), every plugin's host half
  runs on its own worker thread in the daemon. Hooks hear about every pane
  the daemon runs, whichever window shows it, and keep running with no
  window open.
- **Without a daemon**, when a window runs its panes itself, that window
  runs the host halves and their hooks for its own panes. Nothing changes in
  your code, but `tern.pane.list()` and the events cover only that window's
  panes, and effects reach only that window.
- **Remote hosts** run their own plugins' host halves for their panes. Your
  machine's host half never hears about a remote host's panes; your window
  half does, through window events.
- **iOS** runs no host halves.

Because the host half runs in the daemon, `tern.getenv`, `tern.fs` and
`tern.process` there see the daemon's environment and machine, not a
window's.

## Events

`tern.on(name, fn)` in `host.luau` subscribes `fn`:

| Event | Fires when | Payload |
| --- | --- | --- |
| `command_started` | A shell reports that a command line starts running | `{pane, line, cwd?}` |
| `command_finished` | That command ends | `{pane, line, status, took_ms}` |
| `cwd` | A pane's working directory changes | `{pane, path}` |
| `title` | A pane's title changes | `{pane, title}` |
| `pane_exited` | A pane's program exits | `{pane, status}` |
| `spawn` | A shell pane is about to start | the spawn spec; see [below](#the-spawn-filter) |

- `pane` is the pane's id on this host, the id `tern.pane.write` takes.
- `line` is the command line as the shell reported it, as typed (aliases
  not expanded). `cwd` is the shell's directory when the command started,
  when known.
- `status` is the exit status; `took_ms` is how long the command ran, in
  milliseconds, as the host measured it.
- `command_started` and `command_finished` need the shell integration,
  which reports command lines. `command_finished` fires only for a command
  whose start was seen.

An event name the host doesn't know raises at the `tern.on` call. Handlers
of one plugin run in registration order on its worker. Each plugin has its
own worker, so different plugins' handlers run concurrently, in no defined
order. Every handler call has the host's 2 s budget; a slow one delays only
its own plugin.

## The hook `cx`

Event handlers get `(ev, cx)`. The `cx` sends effects to the windows of the
pane the event is about, every window showing that pane's session:

| Method | Effect |
| --- | --- |
| `cx:toast(level, text, sub?)` | A toast; `level` is `"success"`, `"info"` or `"error"` |
| `cx:open(target)` | Opens a path or URL as a link clicked in the pane would, so each window's routes apply |
| `cx:copy(text)` | Puts `text` on the clipboard |

With no window attached, the effects are dropped. Hooks can't touch layout,
the palette or a window's state: that is the window half's job (see
[Layout and Workspaces](layout.md#window-events) for window events).

## Writing to panes

`tern.pane.write(pane, text)` writes `text` into a pane's pseudoterminal,
as if typed. End it with `"\r"` to run a command; leave the `"\r"` off to
put text on the prompt for the person to confirm. The write is applied after
the handler returns, and a pane that no longer exists is ignored.

`tern.pane.list()` returns every pane on this host whose program hasn't
exited, as `{pane, cwd?, program, title, busy}` records. `program` is the
program's name, or the block kind for a plugin block; a block's pane is
listed from before its `init` runs. `busy` reports a running shell-integrated
command, not general process activity.

```lua
local function title_of(pane: number): string?
	for _, info in tern.pane.list() do
		if info.pane == pane then
			return info.title
		end
	end
	return nil
end
```

Writing into a shell is powerful and easy to get wrong: the person may be
typing, or a full-screen program may be running. Prefer leaving a command
on the prompt to running it, and only write in response to something the
person just did in that pane.

## The spawn filter

A `spawn` handler runs before every shell pane on the host starts (plugin
blocks don't spawn processes and never reach it). It receives the spec and
returns the spec to use, or `nil` to leave it unchanged:

```lua
tern.on("spawn", function(spec: SpawnSpec): SpawnSpec?
	spec.env.EDITOR = "nvim"
	return spec
end)
```

| Field | Holds |
| --- | --- |
| `program` | The program, already resolved: the login shell (for example `/bin/zsh`) unless the pane was asked to run something else |
| `args` | Its arguments, including the login flag the daemon adds |
| `cwd` | The directory the pane will start in |
| `env` | The variables Tern sets for the pane, by name |

`env` holds only what Tern adds on top of the environment the pane
inherits, not the inherited environment itself. In a daemon's pane that is
`TERN_IDENTITY`, `TERN_PANE`, `TERN_PANE_SOCKET`, `TERN_WINDOW_KEY`,
`TERN_WINDOW_SOCKET` (empty), `TERN_LENSES` and `TERN_COMPLETE`. So you can
add variables and override these, but you can't remove an inherited
variable: removing a key only stops Tern from setting it. Read inherited
values with `tern.getenv`.

How a returned table is applied:

- `program` and `args`, when missing, keep their previous values.
- `cwd`, when missing or not a directory, is ignored: the pane starts where
  it would have. The daemon expands a leading `~`.
- `env` is taken as the complete set: keys you removed are not set, new
  keys are added. Return the spec you received, modified, rather than a new
  table with only your changes.

The daemon waits for the filter, so it is synchronous and short:

- **Order.** Plugins with a `spawn` handler run in plugin id order, each
  receiving the previous one's result. Several handlers in one plugin run
  in registration order.
- **50 ms per plugin.** The pane waits at most 50 ms for each plugin's
  answer, counted from when the request is queued, so time the worker spends
  finishing another handler counts. A late answer is discarded, the pane
  starts with the spec as it was, and the log says `plugin spawn filter took
  over 50 ms; skipped`.
- **No waiting on processes or requests.** `tern.process.run` and
  `tern.fetch` call back later, after the pane has started. Use `tern.fs`,
  `tern.kv` and string work, and cache anything slow in advance.
- **Failures.** A handler that raises, or returns something other than a
  table or `nil`, leaves the spec as it was and is toasted to every window,
  since no pane exists yet to aim at.

The filter also runs when a window runs its panes without a daemon. There
`env` holds that window's variables instead (`TERN_WINDOW_SOCKET`,
`TERN_WINDOW_PANE`, `TERN_LENSES`, `TERN_COMPLETE`).

## Worked example: projects

This host half gives every new shell `TERN_PROJECT`, the name of the git
repository it starts in; toasts commands that ran for more than 30 seconds,
remembering the last 20; and catches the `gti` typo by putting the
corrected command on the prompt.

`plugin.toml`:

```toml
schema = 1
id = "projects"
name = "Projects"
version = "0.1.0"
description = "TERN_PROJECT in new shells, toasts for slow commands."
host = "host.luau"
```

`host.luau`:

```lua
--!strict
-- New shells get TERN_PROJECT (the name of the git repository they start
-- in); commands that run longer than SLOW_MS toast when they finish; a
-- `gti` typo is corrected on the prompt, waiting for Enter.

local SLOW_MS = 30000

local function repo_root(dir: string): string?
	local at: string? = dir
	while at and at ~= "" do
		if tern.fs.exists(at .. "/.git") then
			return at
		end
		at = string.match(at, "^(.*)/[^/]*$")
	end
	return nil
end

tern.on("spawn", function(spec: SpawnSpec): SpawnSpec?
	local root = if spec.cwd then repo_root(spec.cwd) else nil
	if not root then
		return nil
	end
	spec.env.TERN_PROJECT = string.match(root, "[^/]+$") or root
	return spec
end)

local function title_of(pane: number): string?
	for _, info in tern.pane.list() do
		if info.pane == pane then
			return info.title
		end
	end
	return nil
end

tern.on("command_finished", function(ev: CommandFinishedEvent, cx: EffectCx)
	if ev.took_ms < SLOW_MS then
		return
	end
	local seconds = ev.took_ms // 1000
	local where = title_of(ev.pane) or ("pane " .. ev.pane)
	if ev.status == 0 then
		cx:toast("success", ev.line, string.format("Finished in %ds · %s", seconds, where))
	else
		cx:toast("error", ev.line, string.format("Exit %d after %ds · %s", ev.status, seconds, where))
	end
	local recent = tern.kv.get("slow") or {}
	table.insert(recent, 1, { line = ev.line, status = ev.status, took_ms = ev.took_ms })
	while #recent > 20 do
		table.remove(recent)
	end
	tern.kv.set("slow", recent)
end)

tern.on("command_finished", function(ev: CommandFinishedEvent, _cx: EffectCx)
	local rest = string.match(ev.line, "^gti (.*)$")
	if ev.status == 127 and rest then
		tern.pane.write(ev.pane, "git " .. rest) -- no "\r": Enter runs it
	end
end)
```

Opening a tab in `~/work/stencil/crates` gives a shell where
`echo $TERN_PROJECT` prints `stencil`. Running `gti status` fails with
"command not found" (status 127), and `git status` appears on the next
prompt, waiting for Enter.

Notes on the choices:

- **The filter stays cheap.** `repo_root` makes one `exists` call per
  directory level, well inside 50 ms. It returns `nil` outside a
  repository, which leaves the spec alone.
- **It modifies the spec it got.** Assigning into `spec.env` keeps the
  variables Tern set; returning a fresh `{ env = { TERN_PROJECT = … } }`
  would drop them.
- **Two handlers for one event.** They run in order on the same worker; a
  failure in one doesn't stop the other.
- **The toast goes where the command ran.** `cx` targets the windows
  showing that pane, and the pane's title tells the person which one.
- **`tern.kv` keeps history.** The list survives restarts in the plugin's
  data directory, where a window command could show it. Both halves share
  one `kv.json`, so the window half reads what the host half last set; see
  [Files, Processes, and Storage](io.md).
- **Typing, not running.** The typo fix leaves out `"\r"`, so nothing runs
  without the person pressing Enter.

## Related pages

- [Host API](../reference/api-host.md#ternon) and
  [Events](../reference/events.md): every event and field.
- [Layout and Workspaces](layout.md): window events and the window `cx`.
- [Architecture](../concepts/architecture.md): where the host half runs.
- [Trust and Security](../concepts/security.md): what writing to panes
  implies.
