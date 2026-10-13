# Directory Variables

`dirvars` gives each new shell the variables of the `.tern-env` files
between its directory and the home directory, after explicit approval of
each file's exact contents. Like `direnv`, it does not trust arbitrary
checkout-controlled environment files automatically. It is the example for the host's `spawn`
filter: a synchronous hook on the daemon's spawn path, with a hard time
limit and an environment that holds less than you might expect.

## What it demonstrates

| Surface | Used for |
| --- | --- |
| `tern.on("spawn", fn(spec) -> spec?)` | Adding variables to a shell before it starts |
| `tern.on("cwd")`, `EffectCx:toast` | Telling a running shell that the files where it is now differ |
| `tern.on("pane_exited")` | Forgetting a pane's baseline |
| `tern.fs.exists`, `tern.fs.read(path, max_bytes)` | Walking up the tree and safely bounding regular-file reads |
| `tern.block.define`, `tern.kv` | Reviewing and approving exact file contents on the host |
| `tern.getenv` | The daemon's own environment, as a fallback for `${NAME}` |
| `tern.log.warn` | Reporting malformed lines without interrupting anyone |
| `require("./envfile")` | A parser module kept apart from the hook code |

The plugin is host-only: the manifest names no window entry.

## Install

```sh
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/dirvars
```

While you change it, clone the SDK and link the folder instead, so Tern
reloads it on every save:

```sh
git clone https://github.com/stencil-hq/tern-sdk
tern plugin link tern-sdk/plugins/examples/dirvars
```

Copy `sample.tern-env` to a project as `.tern-env`. Open **Directory
Variables** from the block palette in that project, review the complete
escaped contents, and click **Approve these exact bytes** for each file.
Only then open a new shell pane and run `echo $TERN_DIRVARS`. The optional
block argument selects an absolute project directory.

### Approval is content-specific

Every spawn re-reads each file with the native 64 KiB bound, then compares
its bytes to that path's approved bytes in the plugin's existing KV.
Unknown, changed, unreadable and nonregular content is denied by default.
A change to even a comment invalidates approval; observing a change removes
the stored approval. The block displays every byte (non-ASCII/control bytes
are escaped), with no truncated preview. Clicking approval re-reads the
file and rejects changes since display; it cannot approve unseen contents.
**Refresh files** reviews edits and **Revoke approval** denies future imports.
Approval stores at most 64 KiB per path, on the daemon's machine; the
manifest-listed host block also appears in the palette on remote hosts.

Review the entire file, not just familiar variable names: variables such
as `ZDOTDIR` can make a shell execute checkout-controlled startup code.
Trust in this installed plugin does not imply trust in every project.
No variable denylist is a substitute for this explicit approval step.

## The file format

```sh
# A sample .tern-env: copy it to a project as `.tern-env`.
# Review and explicitly approve its bytes in the Directory Variables block.
# One KEY=VALUE per line; lines starting with # are comments.

# Bare values end at a ` #` comment and expand ${NAME}.
APP_ENV=development   # read by the app's config loader
DATABASE_URL=postgres://localhost:5432/${APP_ENV}

# Double quotes keep spaces and # and understand \n \t \" \\ \$.
GREETING="hello # not a comment"
PRICE="costs \${5}"

# Single quotes are literal: nothing expands.
PATTERN='${not expanded}'

# `export` is accepted, so the file also works with `source`.
export RUST_LOG=info

# A name no file set falls back to the daemon's own environment (${HOME});
# an undefined name expands to nothing.
TOOLS=${HOME}/src/app/bin

# PATH is accepted, but ${PATH} is the daemon's, and a login shell's
# profile runs after the filter and rebuilds PATH (on macOS, path_helper
# puts the system's entries first). Prefer project variables like TOOLS
# and prepend them in your shell's rc file when the order matters.
PATH=${TOOLS}:${PATH}
```

| Form | Meaning |
| --- | --- |
| `KEY=VALUE` | `KEY` matches `[A-Za-z_][A-Za-z0-9_]*`; blanks around `=` are allowed |
| `# …` | A comment line; in a bare value, ` #` (a blank, then `#`) starts a comment |
| `export KEY=VALUE` | Same as without `export`, so the file also works with `source` |
| Bare value | Ends at a ` #` comment; expands `${NAME}` |
| `"double"` | Keeps spaces and `#`; understands `\n \t \" \\ \$`; expands `${NAME}` |
| `'single'` | Literal: no escapes, no expansion |

`$NAME` without braces is left as written: only `${NAME}` expands. A line
that doesn't parse is skipped and logged with its file and line number.

## Design

### What the filter sees

The daemon runs every plugin's `spawn` filter, in plugin id order, on each
shell pane it is about to start. The `SpawnSpec` holds `program`, `args`,
`cwd` (always set) and `env`, and `env` is only what the
daemon itself sets on top of the pane's base environment:

| In `spec.env` | Not in `spec.env` |
| --- | --- |
| `TERN_PANE`, `TERN_IDENTITY`, `TERN_PANE_SOCKET`, `TERN_WINDOW_KEY`, `TERN_WINDOW_SOCKET`, `TERN_LENSES`, `TERN_COMPLETE` | `HOME`, `PATH`, `USER`, `SHELL`, anything from your profile |

A local pane starts from a fresh login's environment (your account's
`HOME`, `USER`, `SHELL` and a `PATH` the login shell builds), not from the
daemon's, and the
daemon applies `spec.env` over it. So `dirvars` can add and override
variables but cannot read the pane's base environment. When `${NAME}`
names something no file set and `spec.env` doesn't hold, it falls back to
`tern.getenv(NAME)`: the daemon process's environment. `${HOME}` is the
same either way; `${PATH}` is the daemon's `PATH`, which may differ from the
shell's.

The filter adds the variables directly to `spec.env` and returns `spec`;
returning `nil` (no file applies) leaves the spec untouched. Keys starting
with `TERN_` are skipped with a warning, since the daemon's own variables
are how the pane talks back to Tern.

### Nearer files win

`chain(cwd)` walks from the pane's directory up to `$HOME` (`USERPROFILE`
on Windows), or to the filesystem root for a directory outside home, and
collects each `.tern-env` that exists, farthest first. Only approved content
applies. `apply` then sets those files' keys in that order, so a key in
`~/src/webapp/api/.tern-env` replaces the same key from
`~/src/webapp/.tern-env`. Expansion happens while applying, so a nearer
file sees what the farther ones set:

```sh
# ~/src/webapp/.tern-env
APP_ENV=development

# ~/src/webapp/api/.tern-env
APP_ENV=test
DATABASE_URL=postgres://localhost:5432/app_${APP_ENV}   # app_test
```

`TERN_DIRVARS` lists the files that applied, farthest first, joined with
`:`, so a shell prompt or script can show where its variables came from.

### Staying under 50 ms

The daemon waits at most 50 ms for each plugin's filter, measured from the
moment it hands the spec over. A filter that runs longer is skipped for
that spawn (the log says `plugin spawn filter took over 50 ms; skipped`),
and the shell starts without its variables. The wait includes any queue:
a host worker handles one message at a time, so a slow hook or block
render in the same plugin delays the filter. The approval block reads and
renders only bounded files; it shares that queue with the filter.

The work per spawn is one `exists` per ancestor directory (typically four
to eight) and one `read` per file found. `tern.fs` has no `stat`, so the
plugin cannot ask whether a file changed since the last spawn. It caches by
content instead:

| Cache key | Cost per spawn | Staleness |
| --- | --- | --- |
| Path only | No reads | An edited file applies only after a plugin reload |
| Path plus a time-to-live | No reads within the TTL | Edits wait out the TTL |
| Path plus content (this plugin) | Reads every file, parses only changed ones | None |

Reading a few small files is microseconds when the operating system has
them cached; parsing is the part worth skipping, and comparing the text
with the cached copy skips it. Files over 64 KiB are refused, which bounds
both the buffered read and the parse. The bound is enforced in native IO
before allocating/reading oversized contents, not after creating a Lua
string. Only regular, non-symlink files are accepted: FIFOs, devices,
directories and raced-in nonregular targets are rejected on Unix and
Windows. A one-byte probe detects growth beyond the bound. Slow regular
files (for example on a network filesystem) can still exceed the filter's
time limit; the bound is not a deadline.

### Running shells

A process's environment is fixed when it starts: no plugin can change the
variables of a shell that is already running. `dirvars` says so instead.
At spawn it remembers, by `TERN_PANE`, which files applied and their
contents. On every `cwd` event it computes the files that apply in the new
directory and keeps those the shell didn't start with or that changed
since. If any remain, it toasts once for that pane, directory and set of
files:

> ~/src/webapp/.tern-env applies here
> This shell didn't load it; new panes pick it up.

Leaving a project is not reported: the toast is about variables you are
missing, not ones you still have. `pane_exited` drops the pane's records.

## Limits

- **New shells only.** Shells that started before the plugin loaded (or
  before a plugin reload) have no recorded baseline, so they get neither
  the variables nor the toast.
- **Startup files run after the filter.** The shell's profile and rc files
  can override any variable, and a login shell rebuilds `PATH` (on macOS,
  `path_helper` puts the system's entries first). Prepend to `PATH` in the
  rc file when order matters.
- **The daemon's machine.** Files are read where the daemon runs; a
  remote host needs the plugin installed there.
- **Shells only.** Plugin blocks don't pass through the `spawn` filter.
- **No unset.** A file can set a variable to the empty string but not
  remove it.

## Code

`plugin.toml`:

```toml
schema = 1
id = "dirvars"
name = "Directory Variables"
version = "0.1.0"
description = "New shells get explicitly approved .tern-env variables above their directory."
icon = "key"
host = "host.luau"

[[blocks]]
id = "approve"
title = "Directory Variables"
palette = true
```

`envfile.luau`:

```lua
--!strict
-- Reads `.tern-env` files: one `KEY=VALUE` per line, `#` comments, an
-- optional `export ` prefix, and values that are bare, 'single-quoted'
-- (literal) or "double-quoted" (escapes `\n \t \" \\ \$`). Bare and
-- double-quoted values expand `${NAME}`; single-quoted ones never do.
--
-- Parsing keeps a value as parts (literal text and variable names), so
-- expanding it later, against whatever came before, is a concatenation.

local envfile = {}

-- Literal `text`, or the name (`var`) of a variable to substitute.
export type Part = { text: string?, var: string? }

export type Entry = {
	key: string,
	parts: { Part },
	line: number,
}

local ESCAPES: { [string]: string } = { n = "\n", t = "\t", ['"'] = '"', ["\\"] = "\\", ["$"] = "$" }

-- Appends `text` to `parts`, splitting out `${NAME}` references.
local function expanding(parts: { Part }, text: string)
	local at = 1
	while true do
		local from, to, name = string.find(text, "%${([%a_][%w_]*)}", at)
		if from == nil then
			break
		end
		if from > at then
			table.insert(parts, { text = string.sub(text, at, from - 1) })
		end
		table.insert(parts, { var = name :: string })
		at = (to :: number) + 1
	end
	if at <= #text then
		table.insert(parts, { text = string.sub(text, at) })
	end
end

-- The parts of a double-quoted value starting after its opening quote, and
-- what follows the closing quote; nil when the quote never closes.
local function quoted(value: string): ({ Part }?, string)
	local parts: { Part } = {}
	local run = {} -- characters since the last escape, still to be expanded
	local i = 1
	while i <= #value do
		local c = string.sub(value, i, i)
		if c == '"' then
			expanding(parts, table.concat(run))
			return parts, string.sub(value, i + 1)
		elseif c == "\\" and i < #value then
			local escaped = ESCAPES[string.sub(value, i + 1, i + 1)]
			if escaped then
				expanding(parts, table.concat(run))
				table.clear(run)
				-- An escaped character is literal: `\$` never starts `${`.
				table.insert(parts, { text = escaped })
				i += 2
				continue
			end
		end
		table.insert(run, c)
		i += 1
	end
	return nil, ""
end

-- Whether what follows a closing quote is only blanks and a comment.
local function trailing_ok(rest: string): boolean
	return string.match(rest, "^%s*$") ~= nil or string.match(rest, "^%s+#") ~= nil
end

-- The entries of `text` in file order, and a message for each line that
-- doesn't read (`"line 4: …"`); those lines are skipped.
function envfile.parse(text: string): ({ Entry }, { string })
	local entries: { Entry } = {}
	local problems: { string } = {}
	local number = 0
	for raw in string.gmatch(text .. "\n", "([^\n]*)\n") do
		number += 1
		local line = string.match(raw, "^%s*(.-)%s*$") :: string
		line = string.gsub(line, "^export%s+", "")
		if line == "" or string.sub(line, 1, 1) == "#" then
			continue
		end
		local key, value = string.match(line, "^([%a_][%w_]*)%s*=%s*(.*)$")
		if key == nil or value == nil then
			table.insert(problems, string.format("line %d: expected KEY=VALUE", number))
			continue
		end
		local parts: { Part } = {}
		local first = string.sub(value, 1, 1)
		if first == "'" then
			local body, rest = string.match(value, "^'([^']*)'(.*)$")
			if body == nil or not trailing_ok(rest :: string) then
				table.insert(problems, string.format("line %d: unterminated single quote", number))
				continue
			end
			table.insert(parts, { text = body })
		elseif first == '"' then
			local got, rest = quoted(string.sub(value, 2))
			if got == nil or not trailing_ok(rest) then
				table.insert(problems, string.format("line %d: unterminated double quote", number))
				continue
			end
			parts = got
		else
			-- A bare value ends at a ` #` comment.
			local bare = string.gsub(value, "%s+#.*$", "")
			expanding(parts, bare)
		end
		table.insert(entries, { key = key, parts = parts, line = number })
	end
	return entries, problems
end

-- `parts` with each variable replaced by `lookup(name)` (empty when nil).
function envfile.expand(parts: { Part }, lookup: (string) -> string?): string
	local out = table.create(#parts)
	for _, part in parts do
		if part.var then
			table.insert(out, lookup(part.var) or "")
		else
			table.insert(out, part.text or "")
		end
	end
	return table.concat(out)
end

return envfile
```

`host.luau`:

```lua
--!strict
-- dirvars, host half: a `spawn` filter that gives each new shell the
-- variables of the `.tern-env` files between its directory and the home
-- directory, but only after the user approves each file's exact contents
-- in the Directory Variables block. A `cwd` hook reports approved changes.

local envfile = require("./envfile")

local FILE = ".tern-env"
-- Larger files are skipped: an env file this big is a mistake.
local MAX_BYTES = 64 * 1024
local function normalize(path: string): string
	local clean = string.gsub(string.gsub(path, "\\", "/"), "/+$", "")
	if clean == "" then
		return "/"
	end
	return if string.match(clean, "^%a:$") then clean .. "/" else clean
end

local home = tern.getenv("HOME") or tern.getenv("USERPROFILE")
local HOME = if home then normalize(home) else nil
local ui = tern.ui
local APPROVAL = "approved:"

-- A file read this far, with what it parsed to. `text` is the cache key:
-- `tern.fs` has no mtime, so every lookup reads the file and parsing runs
-- only when its content changed.
type Parsed = {
	text: string,
	entries: { envfile.Entry },
}

-- The files that applied, farthest first, and their contents.
type Applied = {
	paths: { string },
	texts: { [string]: string },
}

local parsed: { [string]: Parsed } = {}
local invalidated: { [string]: boolean } = {}
-- What each pane started with, by pane id (from the spec's `TERN_PANE`).
local started: { [number]: Applied } = {}
-- Directories each pane was already told about.
local told: { [number]: { [string]: boolean } } = {}

local function parent(dir: string): string?
	if dir == "/" or string.match(dir, "^%a:/$") or string.match(dir, "^//[^/]+/[^/]+$") then
		return nil
	end
	local up = string.match(dir, "^(.*)/[^/]*$")
	return if up == nil or up == "" then "/" else normalize(up)
end

local function join(dir: string, name: string): string
	return if string.sub(dir, -1) == "/" then dir .. name else dir .. "/" .. name
end

local function tilde(path: string): string
	if HOME and string.sub(path, 1, #HOME + 1) == HOME .. "/" then
		return "~" .. string.sub(path, #HOME + 1)
	end
	return path
end

-- The `.tern-env` paths from `cwd` up to the home directory (or the root,
-- for a directory outside home), farthest first.
local function chain(cwd: string): { string }
	local found: { string } = {}
	local dir: string? = normalize(cwd)
	while dir do
		local path = join(dir, FILE)
		if tern.fs.exists(path) then
			table.insert(found, 1, path)
		end
		if dir == HOME then
			break
		end
		dir = parent(dir)
	end
	return found
end

-- The entries of `path`, parsing only when its content changed; nil when it
-- can't be read (gone since `exists`, a directory, no permission) or is too
-- large.
local function load(path: string): Parsed?
	local ok, text = pcall(tern.fs.read, path, MAX_BYTES)
	if not ok then
		return nil
	end
	local hit = parsed[path]
	if hit and hit.text == text then
		return hit
	end
	local entries, problems = envfile.parse(text)
	for _, problem in problems do
		tern.log.warn(string.format("%s %s", path, problem))
	end
	local fresh = { text = text, entries = entries }
	parsed[path] = fresh
	return fresh
end

-- Persist the bounded bytes, not a path-only trust flag. KV failures deny.
-- Forget approval as soon as different or unreadable content is observed.
local function approved(path: string, file: Parsed?): boolean
	local ok, text = pcall(tern.kv.get, APPROVAL .. path)
	if not ok then
		invalidated[path] = true
		return false
	end
	if not invalidated[path] and file and type(text) == "string" and #text <= MAX_BYTES and text == file.text then
		return true
	end
	if text ~= nil then
		invalidated[path] = true
		pcall(tern.kv.set, APPROVAL .. path, nil)
	end
	return false
end

-- The files that apply in `cwd` and their contents.
local function applied(cwd: string): Applied
	local result: Applied = { paths = {}, texts = {} }
	for _, path in chain(cwd) do
		local file = load(path)
		local allowed = approved(path, file)
		if file and allowed then
			table.insert(result.paths, path)
			result.texts[path] = file.text
		end
	end
	return result
end

-- Applies `files` over `env` in place, farthest first, so nearer files win.
-- `${NAME}` sees the keys set so far, then `env`, then the daemon's own
-- environment (`HOME`, `PATH`, …).
local function apply(files: Applied, env: { [string]: string })
	for _, path in files.paths do
		for _, entry in parsed[path].entries do
			if string.sub(entry.key, 1, 5) == "TERN_" then
				-- The daemon's own variables (TERN_PANE, …) aren't ours to change.
				tern.log.warn(string.format("%s line %d: %s is reserved; skipped", path, entry.line, entry.key))
				continue
			end
			env[entry.key] = envfile.expand(entry.parts, function(name: string): string?
				return env[name] or tern.getenv(name)
			end)
		end
	end
	env.TERN_DIRVARS = table.concat(files.paths, ":")
end

tern.on("spawn", function(spec: SpawnSpec): SpawnSpec?
	if spec.cwd == nil then
		return nil
	end
	local files = applied(spec.cwd)
	local pane = tonumber(spec.env.TERN_PANE)
	if pane then
		started[pane] = files
	end
	if #files.paths == 0 then
		return nil
	end
	apply(files, spec.env)
	return spec
end)

-- Files that apply in `now` but that `before` didn't have or had with other
-- content.
local function news(before: Applied, now: Applied): { string }
	local out = {}
	for _, path in now.paths do
		if before.texts[path] ~= now.texts[path] then
			table.insert(out, path)
		end
	end
	return out
end

tern.on("cwd", function(ev: CwdEvent, cx: EffectCx)
	local before = started[ev.pane]
	if before == nil then
		return -- started before this plugin loaded: unknown baseline
	end
	local changed = news(before, applied(ev.path))
	if #changed == 0 then
		return
	end
	local seen = told[ev.pane] or {}
	told[ev.pane] = seen
	local key = ev.path .. "\0" .. table.concat(changed, "\0")
	if seen[key] then
		return
	end
	seen[key] = true
	if #changed == 1 then
		cx:toast("info", tilde(changed[1]) .. " applies here", "This shell didn't load it; new panes pick it up.")
	else
		local text = string.format("%d .tern-env files apply here", #changed)
		cx:toast("info", text, "This shell didn't load them; new panes pick them up.")
	end
end)

tern.on("pane_exited", function(ev: PaneExitedEvent, _cx: EffectCx)
	started[ev.pane] = nil
	told[ev.pane] = nil
end)

-- An approval always refers to the bytes last displayed, never a fresh
-- unseen file. Re-read at click time to reject edits while the block is open.
type Review = { path: string, text: string, token: string }
type State = { cwd: string?, review: { Review } }

local function button(label: string, action: string): Node
	local node = ui.badge(label, "accent")
	local props = node.p or {}
	props.actions = { click = action }
	node.p = props
	return node
end

tern.block.define("approve", {
	init = function(cx: BlockCx, args: { string }, _saved: unknown): State
		return { cwd = args[1] or cx.cwd, review = {} }
	end,
	title = function(_state: State): string?
		return "Directory Variables"
	end,
	view = function(state: State, _cx: BlockCx): BlockView
		state.review = {}
		local parts: { Node } = {
			ui.text("Review every byte before approving. These variables can execute shell startup code. Approval is for this path and exact content only."),
		}
		if state.cwd == nil or state.cwd == "" then
			table.insert(parts, ui.text("No working directory. Open this block from a project pane, or pass an absolute directory as its argument."))
		else
			for _, path in chain(state.cwd) do
				local file = load(path)
				local allowed = approved(path, file)
				table.insert(parts, ui.text(path))
				if file then
					local token = tern.json.encode({ path = path, text = file.text })
					table.insert(state.review, { path = path, text = file.text, token = token })
					-- Quote each line so controls and escape sequences cannot hide bytes.
					-- Include comments and malformed lines too; no truncated preview.
					local lines: { Node } = {}
					for line in string.gmatch(file.text .. "\n", "(.-)\n") do
						local quoted = string.format("%q", line)
						quoted = string.gsub(quoted, "[^ -~]", function(byte: string): string
							return string.format("\\x%02X", string.byte(byte))
						end)
						table.insert(lines, ui.text(quoted))
					end
					table.insert(parts, ui.lines(lines))
					table.insert(parts, button(
						if allowed then "Revoke approval" else "Approve these exact bytes",
						(if allowed then "revoke=" else "approve=") .. token
					))
				else
					table.insert(parts, ui.text("Rejected: unreadable, nonregular, symlink, or larger than 64 KiB."))
				end
			end
			if #state.review == 0 then
				table.insert(parts, ui.text("No readable .tern-env files here. Nothing will be imported."))
			end
		end
		return {
			main = ui.col(parts),
			dock = ui.row({ button("Refresh files", "refresh") }),
		}
	end,
	event = function(state: State, ev: UiEvent, cx: BlockCx)
		if ev.ev ~= "action" then
			return
		end
		if ev.act == "refresh" then
			cx:render()
			return
		end
		-- A delayed click carries the bytes that its own frame displayed,
		-- even if another render or block restart has replaced state.review.
		local review: Review? = nil
		for _, candidate in state.review do
			if candidate.token == ev.value then
				review = candidate
				break
			end
		end
		if review == nil then
			return
		end
		if ev.act == "revoke" then
			invalidated[review.path] = true
			tern.kv.set(APPROVAL .. review.path, nil)
		elseif ev.act == "approve" then
			local current = load(review.path)
			if current == nil or current.text ~= review.text then
				approved(review.path, current)
				cx:toast("warn", "File changed; not approved", "Refresh and review the new contents.")
			else
				tern.kv.set(APPROVAL .. review.path, review.text)
				invalidated[review.path] = nil
				cx:toast("info", "Exact contents approved", "Only new shells load these variables.")
			end
		end
		cx:render()
	end,
})
```
