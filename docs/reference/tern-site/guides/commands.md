# Commands, Keys, and Overrides

A plugin's window half can add rows to the command palette, bind chords to
actions, and take over Tern's built-in commands. All three are window-only:
they run on the window's UI thread, in the plugin's window VM, and each call
gets a fresh window `cx`.

```lua
tern.command({
	id = "scratch",
	title = "Open scratch file",
	icon = "file",
	keys = { "ctrl+alt+shift+s" },
	run = function(cx)
		cx:open(tern.plugin.data .. "/scratch.md", "beside")
	end,
})
```

## Commands

`tern.command(def)` adds a palette row and an action that runs it. The row
lists under `group` and runs `run(cx)` when chosen from the palette, pressed
through a bound chord, clicked as a status segment, or named in the user's
`keybinds`.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | ASCII letters, digits, `_` and `-`; not `bind`. The action name is `plugin.<plugin>.<id>`. |
| `title` | yes | The palette label. |
| `icon` | no | A Tern icon name (`file`, `terminal`, `sparkle`, `branch`, …). Absent or unknown: `puzzle`. |
| `group` | no | The palette group. Default: the manifest `name`. |
| `keys` | no | Default chords, added to the plugin bind layer exactly as `tern.bind` adds them. |
| `available` | no | `fn(cx) -> boolean`: whether the row shows now. |
| `run` | yes | `fn(cx)`: what the command does. |

A bad `id` raises at the call: `tern.command: bad id`. Registering an id the
plugin already registered replaces that row; chords from the earlier
registration's `keys` stay bound.

`available` runs each time the palette lists the plugin's rows, under the
4 ms formatter budget. Any value other than `nil` or `false` shows the row. An
error, or running over budget, hides the row and toasts the failure; a check
that ran over budget stays disabled, so its row stays hidden until the next
reload. Keep it to a few table lookups: it runs for every palette open.

`run` has the ordinary 50 ms window budget. Its failures toast as
`Plugin <name>: command <id> failed`, and an `available` failure as
`available plugin.<plugin>.<id>`. See [Runtime, Budgets, and
JIT](../concepts/runtime.md).

## Action names

An action name is what a chord, a status segment's `command` or a `keybinds`
entry runs. Plugins can name built-in actions and other plugins' actions as
freely as their own.

| Form | What it runs |
| --- | --- |
| A command id: `new_tab`, `split_right`, `close_pane`, `layout:rail`, `move_pane:left`, … | A built-in palette command. |
| `palette`, `goto_tab:N`, `last_tab`, `focus_pane:DIR`, `resize_split:DIR`, `find_older`, `find_newer`, `scroll_top_at_shell`, `scroll_bottom_at_shell` | Built-in actions that are not palette commands. |
| `text:BYTES` | Writes bytes to the focused terminal's program (`\e`, `\r`, `\n`, `\t`, `\\` escapes). |
| `edit.*`, `editor.*`, `markdown.*`, `git.*`, `sqlite.*`, `notebook.*`, `board.*` | Chords of the views that take them. |
| `plugin.<plugin>.<id>` | A plugin's `tern.command`. |
| `plugin.<plugin>.bind.<n>` | A plugin's `n`th function bind. |

[Built-in Actions](../reference/actions.md) lists every name. A plugin action
is checked only when it runs: `plugin.<plugin>.<id>` naming a plugin or
command that isn't loaded parses fine and toasts `No plugin has this action`
when pressed.

## Binds

`tern.bind(chord, action)` binds a chord to an action name or to a function.

```lua
tern.bind("ctrl+alt+shift+n", "new_tab")
tern.bind("ctrl+alt+shift+j", "plugin.scratch.scratch")
tern.bind("ctrl+alt+shift+y", function(cx)
	local pane = cx.session:focused()
	if pane then
		cx:run(pane, "git status\r")
	end
end)
```

Chords are spelled as in `settings.json` `keybinds`: `+`-joined modifiers
(`ctrl`, `alt` or `opt`, `shift`, `cmd` or `super`) and one key, with `>`
joining a sequence (`ctrl+a>c`). A modifier alone is its key tapped, in
sequences of taps only (`shift>shift`: Shift twice within half a second;
Tern's `cmd>cmd` asks Carly). On a PC keyboard (Windows, Linux, and macOS
with `swap_ctrl_cmd`) `cmd` names the Windows or Super key, as it does in
`keybinds`.

A function bind gets the action name `plugin.<plugin>.bind.<n>`, numbered
from 0 in the order the plugin's function binds were made. The number moves
when the plugin adds or reorders binds, so nothing outside the plugin should
name it; register a `tern.command` when a user should be able to rebind the
action.

`tern.bind` raises only when `action` is neither a string nor a function. A
chord that doesn't parse, or an action name that doesn't, is left out of the
keymap with a `plugin bind left out` warning in the log.

## Keymap layering

The keymap is built in layers, each taking its keys from the layers under it:

| Layer, lowest first | Source |
| --- | --- |
| Defaults | Tern's built-in keymap. |
| Preset | `settings.json` `keymap` (another terminal's defaults, such as `tmux`) and `keymap_prefix`. |
| Plugin binds | Every plugin's `tern.bind` and command `keys`, in plugin id order. |
| User | `settings.json` `keybinds`. |

Plugins only add keys. A plugin bind is left out, with the warning `plugin
bind left out: the preset binds these keys`, when the defaults or the preset
already bind the same keys, bind a sequence those keys start, or bind a chord
that starts them (a preset binding `ctrl+b` alone shuts out a plugin's
`ctrl+b>x`). A plugin can add a new sequence under a preset's prefix as long
as that exact sequence is free. Two plugins binding the same keys share the
binding: both actions stay on it in plugin order, and a press runs the first
that applies.

The user layer always wins. A `keybinds` entry replaces every binding of its
keys, plugin binds included, and `"unbind"` or `[]` removes a plugin's chord
without replacing it.

Choose chords the defaults leave free: the hello fixture uses
`ctrl+alt+shift+h`. The binds are rebuilt on every reload and whenever a
plugin registers a bind or command at run time.

## Plugin actions in `settings.json`

Users bind plugin actions the way they bind built-in ones, and their entries
sit above every plugin's:

```json
{
	"keybinds": {
		"cmd+shift+j": "plugin.scratch.scratch",
		"ctrl+alt+shift+h": "unbind"
	}
}
```

An entry may also be a list of action names in priority order; a press runs
the first that applies where focus is. The Keyboard page of Preferences lists
plugin actions in effect with the description "A plugin's action."

## Overrides

`tern.override(command_id, fn)` runs `fn(cx)` before the built-in command
`command_id`. Returning `true` (any value other than `nil` or `false`) skips
the built-in.

```lua
tern.override("new_tab", function(cx)
	cx:toast("info", "Opening a tab")
	cx:command("new_tab") -- Tern's own new_tab; this override doesn't run again
	return true
end)
```

`command_id` is any built-in command id: the names in the first row of the
action table above, such as `new_tab`, `split_right`, `close_pane`,
`reload_config` or `move_pane:left`. An unknown id raises `tern.override:
unknown command`. Actions that aren't palette commands (`palette`,
`goto_tab:N`, `focus_pane:DIR`, the `edit.*` family, …) can't be overridden.

An override runs however the command was started: the palette, a chord, the
menu bar, a toolbar button. Every plugin's overrides of the command run in
plugin id order, then registration order within a plugin, until one returns
true. A failing override toasts and counts as `false`, so the next override,
then the built-in, still runs.

## The recursion guard

While any plugin handler runs, the window's whole plugin runtime is taken out
of the window and put back when the handler returns. Anything the handler
reaches that would consult plugins finds none:

- `cx:command(id)` runs Tern's own command. No override of it runs, the
  calling plugin's or any other's.
- `cx:open(target)` runs Tern's own open. No `tern.route.open` or
  `tern.route.link` handler sees it.
- Built-in commands the handler runs that open files or links skip the routes
  too.

This is what lets an override of `new_tab` call `cx:command("new_tab")`
without recursing, and a route call `cx:open` on the path it was asked about.
It also means a handler can't trigger another plugin's override or route.

Two consequences follow. `cx:command` takes built-in command ids only:
`cx:command("plugin.other.thing")` raises `unknown command`, since plugin
actions are out of reach during the call. And registrations made during a
handler (a `tern.command`, `tern.bind`, `tern.css` or chrome formatter
registered at run time) take effect when the handler returns; a reload
requested during a handler runs after it.

## The window `cx`

Every window handler receives a `cx` that is valid only for that call (see
[Layout and Workspaces](layout.md#the-window-cx)). Its actions:

| Member | Effect |
| --- | --- |
| `cx:run(pane, text)` | Types `text` into the pane's program; end with `"\r"` to run a line. Raises `no program runs in that pane` when there is none. |
| `cx:open(target, how?)` | Tern's own open of a path or URL; routes don't run. With `how`, a path opens in a file block placed by `how`. Without it, the target opens as a link clicked in the focused pane would. |
| `cx:new_block(kind, args?, how?)` | Opens plugin block `kind` (`"<plugin>.<block>"`) on the current host; returns its pane, or `nil` when no Ready plugin there defines the kind. |
| `cx:command(id)` | Runs a built-in command by id; overrides don't run. |
| `cx:toast(level, text, sub?)` | Shows a toast; `level` is `"success"`, `"info"` or `"error"`. |
| `cx:copy(text)` | Puts `text` on the clipboard. |
| `cx.session` | The window's panes and tabs ([Layout and Workspaces](layout.md#reading-the-session)). |
| `cx.layout` | Splits, tabs, focus and workspaces ([Layout and Workspaces](layout.md#arranging-panes)). |

`how` is one of `default`, `beside`, `below`, `split`, `tab`, `replace` or
`preview`; anything else raises `unknown how`. See [Routing Opens and
Links](routing.md#open-requests).

## Worked examples

### A command that shows only where it applies

```lua
local function focused_pane(cx)
	local id = cx.session:focused()
	if id == nil then
		return nil
	end
	for _, pane in cx.session:panes() do
		if pane.pane == id then
			return pane
		end
	end
	return nil
end

tern.command({
	id = "cargo_test",
	title = "Run cargo test",
	icon = "terminal",
	group = "Rust",
	keys = { "ctrl+alt+shift+t" },
	available = function(cx)
		local pane = focused_pane(cx)
		return pane ~= nil and pane.cwd ~= "" and tern.fs.exists(pane.cwd .. "/Cargo.toml")
	end,
	run = function(cx)
		local pane = focused_pane(cx)
		if pane then
			cx:run(pane.pane, "cargo test\r")
		end
	end,
})
```

`available` reads the disk of the machine the window runs on. For a pane on a
remote host, `pane.cwd` names a directory on that host, so the check answers
for the wrong machine; gate on something the window knows instead, or accept
showing the row there.

### Copying the focused directory

```lua
tern.bind("ctrl+alt+shift+c", function(cx)
	local id = cx.session:focused()
	for _, pane in cx.session:panes() do
		local cwd = pane.cwd
		if pane.pane == id and cwd and cwd ~= "" then
			cx:copy(cwd)
			cx:toast("success", "Copied directory", cwd)
			return
		end
	end
end)
```

### New tabs in the repository root

This override opens new tabs at the root of the focused pane's git
repository, and leaves everything else to the built-in:

```lua
local function repo_root(dir: string): string?
	local at = dir
	while at ~= "" and at ~= "/" do
		if tern.fs.exists(at .. "/.git") then
			return at
		end
		at = string.match(at, "^(.*)/[^/]*$") or ""
	end
	return nil
end

tern.override("new_tab", function(cx)
	local id = cx.session:focused()
	for _, pane in cx.session:panes() do
		local cwd = pane.cwd
		if pane.pane == id and cwd and cwd ~= "" then
			local root = repo_root(cwd)
			if root then
				cx.layout:new_tab({ cwd = root })
				return true
			end
		end
	end
	return false -- Tern's own new_tab runs
end)
```

Returning `false` hands the command back. Calling `cx:command("new_tab")`
and returning `true` would do the same, with the chance to act before and
after.

## See also

- [Built-in Actions](../reference/actions.md): every action and command id.
- [Window API](../reference/api-window.md): `tern.command`, `tern.bind`,
  `tern.override` and the `cx` types.
- [Chrome and Styling](chrome.md#status-segments): status segments that run
  actions on click.
- [Debugging](debugging.md): finding left-out binds and failed handlers.
