# Project Workspaces

`workspaces` opens the tabs a project describes in `.tern/workspace.json`:
named tabs, split panes, a directory and a command for each. It is a
window-only plugin and the example for `cx.layout:tab`, built-in command
overrides and a status formatter that stays pure while reflecting state the
plugin changes.

## What it demonstrates

| Surface | Used for |
| --- | --- |
| `tern.command`, `tern.bind` | "Open workspace" and "Edit workspace file" |
| `cx.session:focused()`, `cx.session:panes()` | The focused pane's directory |
| `tern.fs.exists`, `tern.fs.read`, `tern.json.decode` | Finding and reading the workspace file |
| `cx.layout:tab(spec)` | Building each tab from a split tree, and reporting panes that couldn't start |
| `tern.on("window_start")`, `tern.getenv`, `cx.session:tabs()` | Opening `TERN_WORKSPACE` at launch, adopting restored tabs |
| `tern.on("tab_closed")` | Forgetting a workspace when its last tab closes |
| `tern.override("new_tab", fn)` | New tabs at the workspace root |
| `cx.layout:new_tab`, `cx:open` | The override's tab; opening the file |
| `tern.chrome.status`, `tern.chrome.refresh` | The workspace's name in the status line, redrawn when a workspace opens or closes |
| `styles` in the manifest | Styling the plugin's own segment |

## Install

```sh
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/workspaces
```

While you change it, clone the SDK and link the folder instead, so Tern
reloads it on every save:

```sh
git clone https://github.com/stencil-hq/tern-sdk
tern plugin link tern-sdk/plugins/examples/workspaces
```

Then open a shell inside a project that has `.tern/workspace.json` (the
plugin folder has a sample) and run **Open workspace** from the palette or
with `cmd+alt+shift+o` (`ctrl+alt+shift+o` off macOS). To open a workspace
when Tern starts, start Tern with `TERN_WORKSPACE` set to the project root
or to its `workspace.json`:

```sh
TERN_WORKSPACE=~/src/webapp tern
```

## The workspace file

```json
{
  "name": "webapp",
  "tabs": [
    {
      "name": "code",
      "split": "right",
      "panes": [
        { "command": "nvim ." },
        {
          "split": "down",
          "panes": [
            { "cwd": "web", "command": "npm run dev" },
            { "cwd": "api", "command": "cargo watch -x run" }
          ]
        }
      ]
    },
    {
      "name": "shell",
      "panes": [{}, { "block": "longrun.slow" }]
    },
    {
      "name": "infra",
      "cwd": "infra"
    }
  ]
}
```

| Field | Where | Meaning |
| --- | --- | --- |
| `name` | Top level | Shown in toasts and the status line; default: the root folder's name |
| `tabs` | Top level | Non-empty array of tabs, opened in order |
| `name` | Tab | The tab's name |
| `cwd` | Tab, group, pane | Directory, relative to the enclosing one (the root at the top); absolute and `~/` paths work |
| `split` | Tab, group | `right` (default), `down`, `left` or `up`: how `panes` divide |
| `panes` | Tab, group | Array of panes and groups; a tab without `panes` holds one shell |
| `command` | Pane | A command line the login shell runs (`$SHELL -l -c`) |
| `block` | Pane | A plugin block kind, such as `longrun.slow` |
| `args` | Pane | The block's launch arguments (strings); only with `block` |

A pane with neither `command` nor `block` is a shell. A command pane
behaves like any pane whose program ends: when the command succeeds and
exits, the pane closes.

## Design

### From a list of panes to a split tree

`cx.layout:tab` takes a `TabSpec`, a binary tree: a leaf has a `launch`,
an inner node has `split` and two children, `[1]` and `[2]`, and `cwd`
inherits downwards. People think of a tab as "these three panes side by
side", so the file uses lists and `workspace.luau` converts them. `group`
splits a list in two, recursively, with the smaller half first:

```text
panes: [a, b, c], split: right

        right
       /     \
      a      right
            /     \
           b       c
```

`a` gets half the tab and `b` and `c` share the other half, which suits
the common layout of an editor next to two tools. A group inside `panes`
(an entry with its own `panes`) divides its share its own way, as `code`
in the sample does with `split: "down"`.

Every directory is resolved to an absolute path while converting, so the
spec never depends on where the focused pane is when it is built. Tern
creates the first leaf as a new tab, then splits it once per inner node,
and names the tab when the spec has `name`.

### Errors that point at the line

Malformed files are common while someone edits them, so `workspace.load`
validates as it converts and raises messages that name the field:
`tabs[1].panes[2].cwd: must be a string`. It raises with level `0`, which
leaves out Lua's file and line prefix, and the window half catches the
error with `pcall` and shows it in a toast. Nothing is built until the
whole file has converted, so a mistake in the third tab doesn't leave two
tabs behind.

### Finding the root

"Open workspace" takes the focused pane's directory and walks up with
`tern.fs.exists` until it finds `.tern/workspace.json`, the same way `git`
finds `.git`. The window half runs on your machine, so the walk needs no
daemon round trip and costs a few `stat` calls.

### Remembering what is open

The window half keeps `opened`, a table from root to the workspace's name
and the ids of the tabs it built. Each window has its own VM, so each
window has its own table, and a plugin reload starts it empty. `tab_closed`
removes a tab id, and the workspace when its last tab is gone. Opening a
workspace that is already open toasts instead of opening its tabs twice.

### Opening at launch

`window_start` runs once per plugin per window, after the window's
sessions are restored. It reads `TERN_WORKSPACE` from the window process's
environment, accepting the root or the path of its `workspace.json`, and
refuses a relative path, since the window process's working directory says
nothing about what the user meant.

A restored session may already have the workspace's tabs from last time.
Before building, the handler looks for tabs whose name matches one in the
file and whose directory is inside the root, and adopts them into `opened`
instead of opening a second set.

### New tabs at the root

`tern.override("new_tab", fn)` runs before the built-in New Tab, wherever
it comes from: the palette, the menu or its key. When the focused pane is
inside an opened workspace (the deepest root wins when workspaces nest),
the override opens a shell at the root with `cx.layout:new_tab` and
returns `true`, so the built-in doesn't run. Anywhere else it returns
`false` and Tern opens its usual tab. See
[Commands, Keys, and Overrides](../guides/commands.md).

### A pure status segment

The status formatter returns the workspace's name for a pane inside an
opened root. It reads only the in-memory `opened` table, never the disk:
formatters run while Tern draws, under a 4 ms budget, and Tern caches each
answer per input (`{pane, cwd, program, title, busy}`) until a plugin reloads,
registers something or calls `tern.chrome.refresh()`.

`opened` is not part of that input, so a pane that already existed inside
the root would keep its cached answer, no segment, after the workspace
opens. Every change to `opened` (a build, adopting restored tabs at launch,
the last tab of a workspace closing) therefore calls
`tern.chrome.refresh()`, which drops the cached answers and redraws the
status line with the current `opened`.

Clicking the segment runs "Edit workspace file". The manifest's
`workspaces.css` makes the segment bold; Tern installs it as the sheet
`plugin:local:workspaces:styles`, and the selector
`#statusline .sl-plugin[data-plugin="workspaces"]` touches only this
plugin's segments. See [Chrome and Styling](../guides/chrome.md).

## Limits

- **Every window runs `window_start`.** A window opened later with New
  Window starts with no workspace tabs, so with `TERN_WORKSPACE` set it
  opens the workspace too.
- **Local files.** The walk and the read use the window's machine. For a
  pane on a remote host, the directory names a remote path and the
  workspace is found only if the same path exists locally.
- **Missing directories.** A `cwd` that doesn't exist starts the pane at
  the home directory.
- **Missing blocks.** `cx.layout:tab` leaves out a split whose new side
  would start with a block kind no loaded plugin defines, with everything
  under it, and builds the rest; a tab whose first pane is such a block
  isn't opened. Either way it returns an error as its second value, and
  `build` collects them into an "Opened *name* incomplete" toast.
- **Plain JSON.** No comments or trailing commas.

## Code

`plugin.toml`:

```toml
schema = 1
id = "workspaces"
name = "Project Workspaces"
version = "0.1.0"
description = "Opens the tabs a project's .tern/workspace.json describes."
icon = "folder"
window = "window.luau"
styles = ["workspaces.css"]
```

`workspace.luau`:

```lua
--!strict
-- Finds and reads `.tern/workspace.json`, turning it into the tab specs
-- `cx.layout:tab` builds.
--
-- {
--   "name": "webapp",                      -- default: the root's folder name
--   "tabs": [{
--     "name": "dev",                       -- tab name
--     "cwd": "web",                        -- relative to the root (default: the root)
--     "split": "right",                    -- how `panes` divide (default "right")
--     "panes": [                           -- default: one shell
--       {"command": "npm run dev"},        -- a login shell runs it with -c
--       {"block": "longrun.slow", "args": []},
--       {"cwd": "api"},                    -- a shell, relative to the tab's cwd
--       {"split": "down", "panes": [...]}  -- a group, divided its own way
--     ]
--   }]
-- }

local workspace = {}

local FILE = ".tern/workspace.json"
local HOME = tern.getenv("HOME")
local SIDES: { [string]: boolean } = { right = true, down = true, left = true, up = true }

export type Workspace = {
	name: string,
	root: string,
	tabs: { TabSpec },
	-- The tab names, to recognize a restored session's tabs.
	names: { string },
}

-- `path` without trailing slashes.
local function trim(path: string): string
	local out = string.gsub(path, "(.)/+$", "%1")
	return out
end

-- `path` made absolute against `base`; `~` is the home directory.
function workspace.resolve(base: string, path: string): string
	if path == "~" or string.sub(path, 1, 2) == "~/" then
		if HOME == nil then
			error("HOME is not set, so " .. path .. " can't be resolved", 0)
		end
		return trim(HOME .. string.sub(path, 2))
	end
	if string.sub(path, 1, 1) == "/" then
		return trim(path)
	end
	path = string.gsub(path, "^%./", "")
	if path == "" or path == "." then
		return base
	end
	return trim(if base == "/" then "/" .. path else base .. "/" .. path)
end

-- The nearest directory at or above `dir` holding `.tern/workspace.json`.
function workspace.find(dir: string): string?
	local at: string? = trim(dir)
	while at do
		local candidate = if at == "/" then "/" .. FILE else at .. "/" .. FILE
		if tern.fs.exists(candidate) then
			return at
		end
		if at == "/" then
			return nil
		end
		local up = string.match(at, "^(.*)/[^/]*$")
		at = if up == nil or up == "" then "/" else up
	end
	return nil
end

-- Raises `where: message` (no Lua position: the toast shows it as is).
local function fail(where: string, message: string): never
	error(string.format("%s: %s", where, message), 0)
end

local function optional_string(value: any, where: string): string?
	if value ~= nil and type(value) ~= "string" then
		fail(where, "must be a string")
	end
	return value
end

local function side(value: any, where: string): Dir
	local name = optional_string(value, where) or "right"
	if not SIDES[name] then
		fail(where, "must be right, down, left or up")
	end
	return name :: Dir
end

local node: (entry: any, cwd: string, where: string) -> TabSpec

-- `list` divided `split`-wise: the first half on one side, the rest on the
-- other, recursively. With an odd count the first side holds fewer panes,
-- so the first pane (often an editor) gets the most room.
local function group(list: { any }, split: Dir, cwd: string, where: string): TabSpec
	if #list == 0 then
		return {}
	end
	local function range(from: number, to: number): TabSpec
		if from == to then
			return node(list[from], cwd, string.format("%s[%d]", where, from))
		end
		local middle = from + (to - from + 1) // 2 - 1
		return { split = split, range(from, middle), range(middle + 1, to) }
	end
	return range(1, #list)
end

-- One `panes` entry: a group (it has `panes`) or a leaf.
node = function(entry: any, cwd: string, where: string): TabSpec
	if type(entry) ~= "table" then
		fail(where, "must be an object")
	end
	local own = optional_string(entry.cwd, where .. ".cwd")
	local here = if own then workspace.resolve(cwd, own) else cwd
	if entry.panes ~= nil then
		if type(entry.panes) ~= "table" then
			fail(where .. ".panes", "must be an array")
		end
		local spec = group(entry.panes, side(entry.split, where .. ".split"), here, where .. ".panes")
		spec.cwd = spec.cwd or here
		return spec
	end
	local command = optional_string(entry.command, where .. ".command")
	local block = optional_string(entry.block, where .. ".block")
	if command and block then
		fail(where, "has both command and block")
	end
	local args: { string }? = nil
	if entry.args ~= nil then
		if block == nil then
			fail(where .. ".args", "only blocks take args")
		end
		if type(entry.args) ~= "table" then
			fail(where .. ".args", "must be an array of strings")
		end
		args = {}
		for i, arg in entry.args do
			table.insert(args :: { string }, optional_string(arg, string.format("%s.args[%d]", where, i)) :: string)
		end
	end
	return { cwd = here, launch = { command = command, block = block, args = args } }
end

-- The workspace at `root`; raises a readable message when the file is
-- missing or malformed.
function workspace.load(root: string): Workspace
	local path = root .. "/" .. FILE
	local ok, text = pcall(tern.fs.read, path)
	if not ok then
		fail(path, "can't be read")
	end
	local decoded, data = pcall(tern.json.decode, text)
	if not decoded then
		fail(path, "isn't valid JSON (" .. tostring(data) .. ")")
	end
	if type(data) ~= "table" then
		fail(path, "must hold an object")
	end
	local folder = string.match(root, "([^/]+)$") or root
	local name = optional_string(data.name, "name") or folder
	if type(data.tabs) ~= "table" or #data.tabs == 0 then
		fail("tabs", "must be a non-empty array")
	end
	local tabs: { TabSpec } = {}
	local names: { string } = {}
	for i, tab in data.tabs do
		local where = string.format("tabs[%d]", i)
		if type(tab) ~= "table" then
			fail(where, "must be an object")
		end
		local cwd = workspace.resolve(root, optional_string(tab.cwd, where .. ".cwd") or ".")
		local panes = tab.panes or {}
		if type(panes) ~= "table" then
			fail(where .. ".panes", "must be an array")
		end
		local spec = group(panes, side(tab.split, where .. ".split"), cwd, where .. ".panes")
		spec.cwd = spec.cwd or cwd
		spec.name = optional_string(tab.name, where .. ".name")
		if spec.name then
			table.insert(names, spec.name :: string)
		end
		table.insert(tabs, spec)
	end
	return { name = name, root = root, tabs = tabs, names = names }
end

return workspace
```

`window.luau`:

```lua
--!strict
-- workspaces, window half: opens the tabs a project's
-- `.tern/workspace.json` describes, from the palette or at launch
-- (`TERN_WORKSPACE`), starts new tabs at the root of the workspace the
-- focused pane is in, and names that workspace in the status line.

local workspace = require("./workspace")

local OPEN = "plugin.workspaces.open"
local EDIT = "plugin.workspaces.edit"
local HOME = tern.getenv("HOME")

-- A workspace this window opened (or found restored), and its tab ids.
type Opened = {
	name: string,
	root: string,
	tabs: { [number]: boolean },
}

-- Opened workspaces by root. Only this window's VM sees it, and a plugin
-- reload starts it empty.
local opened: { [string]: Opened } = {}

local function tilde(path: string): string
	if HOME and string.sub(path, 1, #HOME + 1) == HOME .. "/" then
		return "~" .. string.sub(path, #HOME + 1)
	end
	return path
end

local function inside(path: string, root: string): boolean
	return path == root or string.sub(path, 1, #root + 1) == root .. "/" or root == "/"
end

-- The opened workspace holding `path`; the deepest root wins when
-- workspaces nest.
local function owner(path: string?): Opened?
	if path == nil then
		return nil
	end
	local best: Opened? = nil
	for root, entry in opened do
		if inside(path, root) and (best == nil or #root > #best.root) then
			best = entry
		end
	end
	return best
end

local function focused_cwd(cx: WindowCx): string?
	local id = cx.session:focused()
	for _, pane in cx.session:panes() do
		if pane.pane == id then
			return pane.cwd
		end
	end
	return nil
end

-- Builds `w`'s tabs and remembers them.
local function build(cx: WindowCx, w: workspace.Workspace)
	local entry: Opened = { name = w.name, root = w.root, tabs = {} }
	local count = 0
	-- What couldn't start: a tab whose first pane failed is missing, a
	-- split whose new side failed is left out of its tab.
	local problems: { string } = {}
	for _, spec in w.tabs do
		local tab, err = cx.layout:tab(spec)
		if tab then
			entry.tabs[tab] = true
			count += 1
		end
		if err then
			table.insert(problems, err)
		end
	end
	if count == 0 then
		local why = if #problems > 0 then table.concat(problems, "; ") else tilde(w.root)
		cx:toast("error", "Workspace " .. w.name .. " opened no tabs", why)
		return
	end
	opened[w.root] = entry
	-- Panes already inside the root get the segment too.
	tern.chrome.refresh()
	if #problems > 0 then
		cx:toast("error", "Opened " .. w.name .. " incomplete", table.concat(problems, "; "))
	else
		cx:toast("success", "Opened " .. w.name, string.format("%d tabs · %s", count, tilde(w.root)))
	end
end

-- Reads the workspace at `root`, toasting the problem when it doesn't load.
local function read(cx: WindowCx, root: string): workspace.Workspace?
	local ok, result = pcall(workspace.load, root)
	if not ok then
		cx:toast("error", "Workspace not opened", tostring(result))
		return nil
	end
	return result
end

local function open_at(cx: WindowCx, root: string)
	local current = opened[root]
	if current then
		cx:toast("info", current.name .. " is already open", tilde(root))
		return
	end
	local w = read(cx, root)
	if w then
		build(cx, w)
	end
end

tern.command({
	id = "open",
	title = "Open workspace",
	icon = "folder",
	run = function(cx: WindowCx)
		local cwd = focused_cwd(cx)
		local root = if cwd then workspace.find(cwd) else nil
		if root == nil then
			cx:toast("error", "No workspace here", "No .tern/workspace.json above " .. tilde(cwd or "this pane"))
			return
		end
		open_at(cx, root)
	end,
})

tern.command({
	id = "edit",
	title = "Edit workspace file",
	icon = "folder",
	run = function(cx: WindowCx)
		local cwd = focused_cwd(cx)
		local root = if cwd then workspace.find(cwd) else nil
		if root == nil then
			cx:toast("error", "No workspace here", "No .tern/workspace.json above " .. tilde(cwd or "this pane"))
			return
		end
		cx:open(root .. "/.tern/workspace.json", "beside")
	end,
})

tern.bind(if tern.runtime.os == "macos" then "cmd+alt+shift+o" else "ctrl+alt+shift+o", OPEN)

-- At launch: the workspace TERN_WORKSPACE names (its root, or its
-- workspace.json). A restored session already has its tabs, so tabs named
-- like the workspace's and inside its root are adopted instead of opened
-- twice.
tern.on("window_start", function(cx: WindowCx)
	local target = tern.getenv("TERN_WORKSPACE")
	if target == nil or target == "" then
		return
	end
	local first = string.sub(target, 1, 1)
	if first ~= "/" and first ~= "~" then
		cx:toast("error", "TERN_WORKSPACE must be an absolute path", target)
		return
	end
	local root = workspace.resolve("/", target)
	root = string.gsub(root, "/%.tern/workspace%.json$", "")
	local w = read(cx, root)
	if w == nil then
		return
	end
	local names: { [string]: boolean } = {}
	for _, name in w.names do
		names[name] = true
	end
	local restored: Opened = { name = w.name, root = root, tabs = {} }
	for _, tab in cx.session:tabs() do
		if tab.name and names[tab.name] and tab.cwd and inside(tab.cwd, root) then
			restored.tabs[tab.id] = true
		end
	end
	if next(restored.tabs) then
		opened[root] = restored
		tern.chrome.refresh()
	else
		build(cx, w)
	end
end)

tern.on("tab_closed", function(ev: TabEvent, _cx: WindowCx)
	for root, entry in opened do
		if entry.tabs[ev.tab] then
			entry.tabs[ev.tab] = nil
			if next(entry.tabs) == nil then
				opened[root] = nil -- the last of its tabs closed
				tern.chrome.refresh()
			end
		end
	end
end)

-- A new tab from a pane inside an opened workspace starts at its root;
-- anywhere else the built-in runs (returning false).
tern.override("new_tab", function(cx: WindowCx): boolean
	local entry = owner(focused_cwd(cx))
	if entry == nil then
		return false
	end
	return cx.layout:new_tab({ cwd = entry.root }) ~= nil
end)

-- Pure: reads only `opened`, never the disk. Tern caches the answer per
-- pane input, so every change to `opened` calls `tern.chrome.refresh()`.
tern.chrome.status(function(pane: PaneInfo): { StatusSegment }?
	local entry = owner(pane.cwd)
	if entry == nil then
		return nil
	end
	return { { text = entry.name, icon = "folder", command = EDIT } }
end)
```

`workspaces.css`:

```css
/* The workspace's status segment reads as a label, not a hint. */
#statusline .sl-plugin[data-plugin="workspaces"] {
	font-weight: 600;
}
```
