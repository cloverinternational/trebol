# Layout and Workspaces

A plugin's window half can follow what happens in a window (focus moving,
panes and tabs coming and going, commands running) and arrange the window
itself: open tabs, split panes, move, resize and close them, and build whole
workspaces. Both go through the window `cx`.

```lua
tern.on("window_start", function(cx)
	local pane = cx.layout:new_tab({ cwd = "/tmp" })
	if pane then
		cx.layout:split(pane, "down", { command = "htop" })
	end
end)
```

## Window events

`tern.on(name, fn)` in the window half subscribes to the window's events.
An unknown name raises `tern.on: unknown window event`.

| Event | Handler | When |
| --- | --- | --- |
| `window_start` | `fn(cx)` | Once per window and plugin, after the window's session settled (restored or started fresh). |
| `focus` | `fn({pane, tab}, cx)` | The focused pane changed. |
| `pane_created` | `fn({pane}, cx)` | A pane was added. |
| `pane_closed` | `fn({pane}, cx)` | A pane went away. |
| `tab_created` | `fn({tab}, cx)` | A tab was opened. |
| `tab_closed` | `fn({tab}, cx)` | A tab went away. |
| `command_started` | `fn({pane, line}, cx)` | A shell began running a command line. |
| `command_finished` | `fn({pane, line, status, took_ms}, cx)` | The command line ended with exit `status` after `took_ms` milliseconds. |
| `cwd` | `fn({pane, path}, cx)` | A pane's working directory changed. |
| `title` | `fn({pane, title}, cx)` | A pane's program set its title. |

Events describe what this window's session saw, remote hosts' panes
included; each window delivers its own. They are queued as the session
changes and delivered after the window draws, never in the middle of a
session change, each to every plugin's handlers in plugin id order.
`command_started` and `command_finished` need a shell that reports its
command lines, as Tern's shell integration does.

The window half's `command_started` has no `cwd`, unlike the [host
hook](hooks.md) of the same name; read the directory from
`cx.session:panes()` or the `cwd` event. A host half sees the same shell
events once, where the panes run; a window half sees them in every window
showing the session.

`window_start` runs for each plugin once per window. A reload doesn't run it
again for plugins that already ran it in that window, but does run it for a
plugin new since (just installed, or turned on). Opening a second window
runs it there too. A handler that changes the session in response to an
event causes more events: a `focus` handler that focuses another pane hears
`focus` again on the next delivery, so guard against loops.

## The window `cx`

Every window handler gets a `cx` as its last argument: event handlers,
commands, binds, overrides, routes and `available` checks. It works only
during the call that received it. A `cx` kept in an upvalue and used later
raises an error.

Timer, process and fetch callbacks don't inherit the `cx` of the call that
started them; they receive a fresh one:

```lua
tern.on("window_start", function(_cx)
	tern.timer(2000, function(cx)
		if cx then
			cx:toast("info", "Two seconds in")
		end
	end)
end)
```

The `cx` parameter of a timer is typed optional because host timers get none;
in the window half it is always set. See [Files, Processes, and
Storage](io.md#timers-and-time).

## Reading the session

`cx.session` reads the window's panes and tabs:

| Method | Returns |
| --- | --- |
| `cx.session:panes()` | Every pane in a tab: `{pane, cwd, program, title, busy}` each (`cwd` is `""` when unknown; `busy` reports a running shell-integrated command). |
| `cx.session:tabs()` | Every tab: `{id, name?, cwd, program, title, panes, busy}`, describing each tab's focused pane. |
| `cx.session:focused()` | The focused pane's id, or `nil`. |
| `cx.session:resolve(spec)` | The pane `spec` names, or `nil`. |

`resolve` names panes the way `tern` scripts name blocks: `"@focused"`, a
pane id written as a string, an exact title, a title in any case, then a
program name. Among several matches, one in the active tab wins.

### Ids

Pane and tab ids are Lua numbers. A remote host's panes carry the host in the
high bits of their ids; Tern moves that tag lower for Lua so the id stays
exact in a double. Pass ids back to `cx` exactly as you received them, and
don't compare ids between windows or with ids from the host half or `tern`
scripts: a remote pane's id is spelled differently there.

## Arranging panes

`cx.layout` changes the window's layout:

| Method | Effect |
| --- | --- |
| `cx.layout:new_tab(launch?)` | Opens a tab in the current session running `launch`, makes it active, returns its pane. |
| `cx.layout:split(target, dir, launch?)` | Splits pane `target` with a new pane on its `dir` side running `launch`; the new pane takes its tab's focus. Returns the new pane. |
| `cx.layout:focus(pane)` | Focuses a pane in this window. |
| `cx.layout:close(pane)` | Closes a pane. |
| `cx.layout:move(pane, target, dir)` | Moves `pane` to the `dir` side of `target`. Returns `false` when either pane is missing or they are on different hosts. |
| `cx.layout:resize(pane, dir, cells)` | Moves the pane's nearest divider toward `dir` by about `cells` of the pane's cells; a negative count moves it the other way. Returns `false` when no split runs that way. |
| `cx.layout:tab(spec)` | Builds a workspace tab (below); returns its tab id. |

`dir` is `"right"`, `"down"`, `"left"` or `"up"`; anything else raises
`unknown direction`.

`new_tab` and `split` return `nil` when the launch names a block type the
host lacks; `split` also when `target` is in no tab. A new tab starts on the
current session's host, in the directory a new tab would (the
`new_tabs` setting) unless the launch names one. A split starts on
`target`'s host, in `target`'s directory unless the launch names one.

Layout changes are session changes: they replicate to every window showing
the session. Focus is the exception. `cx.layout:focus` moves this window's
focus only, and other windows keep their own.

### Launch tables

A `launch` table says what a new pane runs:

| Field | Meaning |
| --- | --- |
| `cwd` | The directory it starts in. |
| `command` | A command line the pane runs through the login shell, in place of an interactive shell. |
| `block` | A plugin block kind, `"<plugin>.<block>"`, to open instead of a shell. |
| `args` | The block's launch arguments (strings), passed to its `init`. |

With no launch, or an empty one, the pane runs an interactive shell. A
`block` must be a block type of a Ready plugin on the pane's host. See
[Blocks](blocks.md).

## Workspaces

`cx.layout:tab(spec)` builds a tab from a tree of splits in one call:

| Field | Meaning |
| --- | --- |
| `cwd` | Directory for this node, inherited by everything under it. |
| `name` | The tab's name (top level only). |
| `split` | Direction of the split between `[1]` and `[2]`: `"right"` (default), `"down"`, `"left"` or `"up"`. |
| `[1]`, `[2]` | The two sides of the split, each a spec. |
| `launch` | What a leaf (a spec without `[1]` and `[2]`) runs; default a shell. |

The tab opens with the leftmost leaf's pane, then each split adds its second
side. A `cwd` deeper in the tree overrides one above it, and a leaf's
`launch.cwd` overrides both. `tab` returns the tab's id, and names the tab
it built even when another tab is active by the time it finishes.

A second return value reports panes that couldn't start. When the first
pane can't open, no tab opens and `tab` returns `nil` and the error. When a
later split's new side can't start, for example a `launch.block` that no
Ready plugin on the host defines, Tern leaves that side and its subtree out,
builds and names the rest, and returns the tab's id with an error such as
``could not start block `<kind>` ``. Tern toasts nothing, so check it:

```lua
local tab, err = cx.layout:tab(spec)
if err then
	cx:toast("error", "Workspace opened incomplete", err)
end
```

```lua
tern.command({
	id = "api",
	title = "Open the api workspace",
	run = function(cx)
		cx.layout:tab({
			name = "api",
			cwd = "/srv/api",
			split = "right",
			{ launch = { command = "nvim" } },
			{
				split = "down",
				{ launch = { command = "cargo watch -x test" } },
				{},
			},
		})
	end,
})
```

Run from the palette, this opens a tab named `api`: `nvim` on the left; on
the right, `cargo watch` above an interactive shell, all in `/srv/api`.

## A workspace at launch

A window half that opens a project workspace whenever a window starts,
unless the session already has it (a restored session brings its tabs back):

```lua
local ROOT = (tern.getenv("HOME") or "") .. "/work/stencil"

tern.on("window_start", function(cx)
	for _, tab in cx.session:tabs() do
		if tab.name == "stencil" then
			return
		end
	end
	if not tern.fs.exists(ROOT) then
		return
	end
	cx.layout:tab({
		name = "stencil",
		cwd = ROOT,
		split = "right",
		{ launch = { command = "nvim" } },
		{ launch = { command = "cargo watch -x check" } },
	})
end)
```

`window_start` runs in every window, so the check matters: without it each
new window would add another workspace tab to the session.

### Keeping a log pane beside builds

Events and layout calls combine. This plugin opens a pane below any pane
whose command fails, running a shell in the same directory, at most one per
pane:

```lua
local opened: { [number]: boolean } = {}

tern.on("command_finished", function(ev, cx)
	if ev.status == 0 or opened[ev.pane] then
		return
	end
	opened[ev.pane] = true
	cx.layout:split(ev.pane, "down")
	cx.layout:focus(ev.pane)
end)

tern.on("pane_closed", function(ev, _cx)
	opened[ev.pane] = nil
end)
```

The `split` gives the new pane focus; the `focus` call hands it back to the
pane that ran the command.

## See also

- [Commands, Keys, and Overrides](commands.md): `cx` actions such as
  `cx:run` and `cx:new_block`.
- [Host Hooks and the Spawn Filter](hooks.md): the host half's view of the
  same shells.
- [Events](../reference/events.md): every event and payload in both halves.
- [Project Workspaces](../examples/workspaces.md): a complete workspace
  plugin.
