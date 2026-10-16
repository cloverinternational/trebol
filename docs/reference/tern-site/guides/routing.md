# Routing Opens and Links

Routes let a plugin's window half decide what happens when someone opens a
file or follows a link: open a plugin block instead, redirect to another URL
or path, or handle it entirely. They run before Tern's built-in handling, so
they can claim paths that don't exist and URL schemes Tern doesn't know.

```lua
tern.route.open(function(req, _cx)
	if string.match(req.path, "%.tfplan$") then
		return { block = "terraform.plan", args = { req.path } }
	end
	return nil
end)
```

## Two routes

| Route | Asked about | Handler |
| --- | --- | --- |
| `tern.route.open(fn)` | File opens a person asked for. | `fn(req, cx) -> decision?` |
| `tern.route.link(fn)` | Links followed in panes and blocks, and URLs the system hands Tern. | `fn(link, cx) -> decision?` |

Both are window-only. A plugin may register several handlers of each.
Handlers run in plugin id order, then in registration order within a
plugin, until one returns a decision; `nil` passes to the next. When every
handler passes, Tern's built-in handling runs.

Each handler call has the 50 ms window budget and gets a fresh `cx`. A
handler that errors (or returns something other than a table or `nil`) is
toasted as `Plugin <name>: route.open failed` (or `route.link`) and counts
as `nil`; the next handler runs.

## Open requests

`req` describes one file about to open:

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | `string` | Absolute path; canonical (symlinks and `..` resolved) when the file exists. |
| `line` | `number?` | 1-based line to reveal. |
| `col` | `number?` | 1-based column on it. |
| `host` | `string` | Name of the host the file lives on. |
| `how` | `string` | Where it would open (below). |
| `origin` | `string` | What asked for it (below). |

`how` says where the built-in open would place the file:

| `how` | Placement |
| --- | --- |
| `default` | Tern's usual place: the block already showing the file, else a new block per the open's context. |
| `beside` | A split beside the focused pane. |
| `below` | A split below it. |
| `split` | A split the gesture picked (a drop onto a pane's edge). In a decision, `split` means `beside`. |
| `tab` | A new tab. |
| `replace` | In place of the block it came from (a link in a file block, a peek). |
| `preview` | The tab's preview block. |

`origin` names the path through the UI:

| `origin` | Produced by |
| --- | --- |
| `palette` | Opening a file from the command palette (Open file…). |
| `files` | Opening a file from the Files pane. |
| `drop` | Dropping files onto the window. |
| `link` | A file path clicked in a terminal; a file link in a pane that no `tern.route.link` handler claimed; a link in a file block; opening a peek's file. |
| `system` | The system: Finder's Open With, a drop on the Dock icon, `--open-file`, a second launch. |
| `cli` | `tern open` in a pane (see [below](#tern-open-from-a-pane)). |
| `carly` | A file opened by Carly's window context; URL opens consult `tern.route.link` first. |

A path printed in a terminal goes straight to `tern.route.open` (origin
`link`); it is a path, not a URL, so `tern.route.link` never sees it. A
`file://` URL or a hyperlink to a file is a link: `tern.route.link` sees it
first and, when no handler claims it, `tern.route.open` sees the file.

Opens Tern makes on its own are not routed: the Files pane's preview, git
and board blocks opening a file, Open logs and app state, the "Open with"
menu items, `tern db`, and every `cx:open` a plugin handler makes.

## Link requests

`link` describes one link being followed:

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | `string` | The URL as written: `https://…`, `file://…`, a custom scheme, or a path the link names. |
| `pane` | `number?` | The pane the link is in; `nil` when it came from no pane. |
| `mods` | table | Modifiers held: `cmd` (⌘; Super on a PC), `alt`, `shift`, `ctrl`, each a boolean. |

`tern.route.link` is asked about:

- link clicks in terminal panes (URLs and OSC 8 hyperlinks);
- the pane link menu's "Open file", "Open link" and "Open link in browser"
  items ("Open link in Tern" opens the browser block directly);
- URL links in file blocks and other surfaces;
- opens a host half asks for with its effect `cx:open(target)`;
- URLs the system hands Tern (a link of a scheme registered to Tern);
- the `url` of a `tern.route.open` decision.

## Decisions

A decision is a table with one of `block`, `url`, `path` or `handled` set.
When several are set, the first in that order counts. A table with none of
them is an error: `a route decision sets block, url, path or handled = true`.

| Decision | From `tern.route.open` | From `tern.route.link` |
| --- | --- | --- |
| `nil` | Next handler, then the built-in open. | Next handler, then the built-in link handling. |
| `{block = "<plugin>.<block>", args = {…}}` | Opens that plugin block with `args` (default `{}`) on the file's host (`req.host`), beside the focused pane (in a new tab or below it when `req.how` is `tab` or `below`), starting in the file's folder. | Opens that plugin block with `args` on the link's pane's host, beside that pane, starting in its directory. |
| `{url = "…"}` | Follows the URL instead: `tern.route.link` handlers see it once, then the built-in link handling, which doesn't route a file URL back through `tern.route.open`. | Follows that URL with the built-in handling; no route sees it again. |
| `{path = "…", how? = …}` | Opens that path with the built-in open, placed by `how` when given, else by `req.how`. | Opens that path in a file block on the pane's host, placed by `how` when given, else in the default place (beside the pane with ⌥). |
| `{handled = true}` | Nothing else runs. | Nothing else runs. |

A `how` in a decision that isn't one of the seven names is an error. A
`block` kind must be a block type of a Ready plugin on the host the block
opens on: the file's for `tern.route.open`, the link's pane's for
`tern.route.link`. A file on a remote host opens the block there, so the
plugin's host half must be installed on that machine. When no Ready plugin
there defines the kind, nothing opens (the built-in doesn't run either) and
an error toast says "Could not open the block", with `No plugin on <host>
defines block type <kind>` beneath.

`handled` means the plugin did whatever the open needed, often through `cx`.
It must be exactly `true`; `{handled = false}` is an error, not a pass.

## "Open with" menus

A block type that declares `files` globs in the manifest gets an "Open with
`<title>`" item in a file block's ⋯ menu and in the Files pane's context
menu for a matching file, without taking over every open:

```toml
[[blocks]]
id = "plan"
title = "Terraform Plan"
files = ["*.tfplan", "*.plan.json"]
```

Globs match the file name only, with `*` and `?`, ASCII case-insensitively.
The items list the block types of Ready plugins on the current session's
host, and appear only for files on that host. Choosing one opens the block
beside the focused pane, in the file's folder, with `args = {<absolute
path>}`. These opens don't pass through `tern.route.open`.

Prefer `files` when a block is one way of looking at a file among several,
and a route when the plugin's view should be the default.

## `tern open` from a pane

`tern open PATH` run in a pane opens the file in the Tern window showing
that pane, routes included:

- In a pane of a session daemon (the usual case), the command talks to that
  daemon, which relays the request to one window that takes opens: the
  focused window when it shows the session, else the one that connected most
  recently. That window opens each file with origin `cli`, routes first,
  and answers the command.
- In a pane of a window running without a daemon, the command talks to the
  window's own socket, with the same result.
- When no window takes the daemon's opens, the daemon opens the files itself
  as an edit of the session's layout that every attached window adopts (a
  daemon no window shows gets a window started for it). No window half runs
  the open, so no route sees it.

The command reports the blocks that opened, and `--wait` waits for them to
close. A route that returns `{block = …}` gives the command that block to
wait on. A route that returns `{url = …}` or `{handled = true}` leaves no
block, and the command fails with `PATH cannot open in a file block`. Since
`EDITOR='tern open --wait'` is how Tern edits commit messages, leave
`origin == "cli"` opens alone unless the plugin opens a block for them.

## Recursion

While a route handler runs, every plugin's routes and overrides are out of
the window ([the recursion guard](commands.md#the-recursion-guard)). A
handler can call `cx:open(req.path)` to run the built-in open on the path it
was asked about, or `cx:open(other, "beside")` for another file, without its
own route seeing the result. The same holds for opens a handler causes
through `cx:command`.

## Worked examples

### A file type as a block, except where the user asked for text

```lua
local claimed = { files = true, palette = true, link = true, system = true }

tern.route.open(function(req, _cx)
	if not string.match(req.path, "%.ipynb$") then
		return nil
	end
	if not claimed[req.origin] or req.how == "replace" then
		return nil -- `tern open`, drops and in-place opens stay text
	end
	return { block = "nb.viewer", args = { req.path } }
end)
```

### Redirecting and claiming links

```lua
tern.route.link(function(link, cx)
	-- Shift-click copies a web link instead of following it.
	if link.mods.shift and string.match(link.url, "^https?://") then
		cx:copy(link.url)
		cx:toast("success", "Link copied", link.url)
		return { handled = true }
	end
	-- A private scheme: ticket://PROJ-123 opens the tracker.
	local key = string.match(link.url, "^ticket://(%u+%-%d+)$")
	if key then
		return { url = "https://tracker.example.com/browse/" .. key }
	end
	return nil
end)
```

A program can mark any URL, custom schemes included, as an OSC 8 hyperlink;
clicking it asks `tern.route.link` like any other link.

### Opening the source instead of the build output

```lua
tern.route.open(function(req, _cx)
	local root, rest = string.match(req.path, "^(.*)/dist/(.-)%.js$")
	if root == nil or rest == nil then
		return nil
	end
	local source = root .. "/src/" .. rest .. ".ts"
	if tern.fs.exists(source) then
		return { path = source, how = "beside" }
	end
	return nil
end)
```

`tern.fs` reads the disk of the machine the window runs on. A request whose
`host` names a remote host is about a file there, so for remote files the
check answers about the wrong machine.

## See also

- [Blocks](blocks.md): defining the block types routes open.
- [Commands, Keys, and Overrides](commands.md): the window `cx` and the
  recursion guard.
- [Window API](../reference/api-window.md): `OpenRequest`, `LinkRequest` and
  `RouteDecision`.
- [Manifest Reference](../reference/manifest.md): `[[blocks]] files`.
