# Chrome and Styling

A plugin's window half can retitle tabs and the window, add segments to the
status line, and add global CSS. Titles and segments come from chrome
formatters: pure functions of a small input table that Tern calls while it
draws, so they run under a tight budget and their results are cached.
Styles come from the manifest's `styles` files and from `tern.css`.

```lua
tern.chrome.tab_title(function(tab)
	if tab.name then
		return nil -- keep names the user gave
	end
	return string.match(tab.cwd or "", "([^/]+)/*$")
end)
```

## Formatters

| Formatter | Called for | Result | Several plugins |
| --- | --- | --- | --- |
| `tern.chrome.tab_title(fn)` | Each tab of the current session. | A title string, or `nil` for Tern's own. | The first plugin, in id order, that gives a title wins. |
| `tern.chrome.window_title(fn)` | The window. | A title string, or `nil` for Tern's own. | The first plugin that gives a title wins. |
| `tern.chrome.status(fn)` | The focused pane. | A list of segments, or `nil` for none. | Every plugin's segments show, in plugin id order. |

Each plugin has one formatter per slot; registering again replaces it. An
empty string counts as `nil`. A formatter's title replaces Tern's even for a
tab the user renamed, so check `tab.name` when user names should win.

Formatters are pure:

- **No `cx`.** A formatter receives only its input table. It can read
  `tern.kv`, `tern.fs` and upvalues, but it cannot act on the window.
- **4 ms budget.** A formatter that runs longer raises `tern: tab_title
  exceeded 4 ms` (or `window_title`, `status`), is toasted, and stays
  disabled until the next reload.
- **Cached by input.** Each distinct input table is formatted once; Tern
  reuses the result until the input changes. The cache keeps up to 256
  inputs per formatter and is dropped whenever a plugin reloads or registers
  anything (a command, bind or formatter), and on `tern.chrome.refresh()`.

Failures (an error, a wrong return type, running over budget) are toasted as
`Plugin <name>: <slot> failed` after the frame that hit them; the frame uses
Tern's own title or no segments.

## Refreshing

Tern redraws the chrome when the session changes (focus, a title, a
directory, a command starting or ending) and when a pane prints. A formatter
whose answer depends on something outside its input (the clock, a file, a
process result) would show its first answer until one of those happens.
Keep that data in an upvalue and call `tern.chrome.refresh()` after it
changes:

- It drops this window's cached results of every formatter (tab titles, the
  window title, status segments).
- It wakes the window and redraws its tabs, status line and title on the
  next frame, so every formatter runs again with the current input.

Only that window refreshes; each window has its own window half. Calling
`refresh` from a formatter raises `tern.chrome.refresh: not from a
formatter` (it would run the formatter again on every frame): call it from a
timer, a process or fetch callback, an event handler or a command.

A segment that ticks calls it from a `tern.timer`, once a second while there
is something to count, and stops the timer when there isn't, so an idle
window runs no Lua. [Long-Running Commands](../examples/longrun.md) shows
the focused pane's running time this way. The
[example below](#a-segment-fed-by-a-process) refreshes after each poll.

## Inputs

`tab_title(tab)` gets:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `number` | Tab id. |
| `name` | `string?` | The name the user gave the tab. |
| `cwd` | `string` | The focused pane's directory; `""` when unknown. |
| `program` | `string` | The focused pane's program. |
| `title` | `string` | The focused pane's title. |
| `panes` | `number` | How many panes the tab has. |
| `busy` | `boolean` | Whether a command is running in one of them. |

`window_title(win)` gets:

| Field | Type | Meaning |
| --- | --- | --- |
| `space` | `string` | The current session's name (Tern's own window title). |
| `tab` | `string?` | The active tab's title. |
| `pane` | `number?` | The focused pane's id. |
| `cwd` | `string?` | The focused pane's directory. |
| `tabs` | `number` | How many tabs the current session has. |

`status(pane)` gets the focused pane:

| Field | Type | Meaning |
| --- | --- | --- |
| `pane` | `number` | Pane id. |
| `cwd` | `string` | Its directory; `""` when unknown. |
| `program` | `string` | Its program. |
| `title` | `string` | Its title. |

`cx.session:tabs()` and `cx.session:panes()` return tables of the same
shapes as `tab_title` and `status` receive. A pane on a remote host reports a
directory on that host; `tern.fs` reads the window's own machine.

## Status segments

A status formatter returns a list of segment tables:

| Field | Required | Meaning |
| --- | --- | --- |
| `text` | yes | The segment's text. |
| `icon` | no | A Tern icon name shown before the text; an unknown name shows no icon. |
| `tone` | no | Color: `accent`, `muted`, `ok`, `warn`, `error` (or `bad`) have Tern styles; any other value is only an attribute for your CSS. |
| `command` | no | An action name run on click (`"new_tab"`, `"plugin.<plugin>.<id>"`). |

A segment without `text`, or a list item that isn't a table, fails the
formatter. A `command` is parsed when the segment is clicked; one that
doesn't parse toasts `A status segment's command is unknown`.

Segments render at the end of the status line, after the pane size:

```html
<footer id="statusline">
	…
	<span class="sl-plugins">
		<span class="sl-plugin" data-plugin="ID" data-tone="TONE">ICON TEXT</span>
		<span class="sl-plugin on" data-plugin="ID" role="button" title="COMMAND">…</span>
	</span>
</footer>
```

`data-tone` is present only when the segment sets `tone`. A segment with a
`command` gets the class `on`, `role="button"` and its action name as the
tooltip. The status line shows only while the status bar is on (the
`status_bar` command).

## Global CSS

Two sources install style sheets into every window on the machine:

| Source | Sheet name | When |
| --- | --- | --- |
| Manifest `styles` | `plugin:local:<id>:styles` | At load, before the window entry runs. The files are concatenated in order (at most 256 KiB in total). Works without a window entry, and stays when the window entry fails to load. |
| `tern.css(name, source)` | `plugin:local:<id>:<name>` | When the call that made it returns: after the entry finishes loading, or after the handler that called it. |

`name` is ASCII letters, digits, `_` and `-`, and not `styles`; anything else
raises `tern.css: bad name`. Calling `tern.css` again with the same name
replaces that sheet in place, so a plugin can restyle at run time (from a
command, an event, a timer).

A remote host's plugins style your windows too: each Ready plugin on an
attached host with manifest `styles` installs as `plugin:<slot>:<id>:styles`,
where `<slot>` is the window's number for that host. Only manifest styles
travel: `tern.css` belongs to window halves, and a remote host's window
halves don't run in your windows. See [Distribution](distribution.md#remote-hosts).

The web tab runs no Lua, so `tern.css` sheets never reach it. It installs
the manifest `styles` of the Ready plugins of the daemon that served it, as
`plugin:0:<id>:styles`, and re-installs them when that daemon's plugins
reload.

### The cascade

Plugin sheets sit after Tern's own sheets, so a rule of equal specificity
wins over Tern's. A sheet goes last the first time its name is installed and
keeps its place when replaced. A reload removes every `plugin:local:*` sheet
and installs them again, manifest styles first, then `tern.css` sheets.
Order between plugins (and between local and remote hosts' sheets) shifts
with reloads; don't depend on it, and use specificity when two plugins style
the same elements.

CSS parse errors don't raise: they are logged as `plugin style sheet has
errors` with the sheet's name.

### Useful selectors

| What | Selector |
| --- | --- |
| A plugin's status segments | `#statusline .sl-plugin[data-plugin='<id>']`, with `[data-tone='…']` and `.on` |
| A plugin block's regions | `.sf-main[data-surface='plugin.<plugin>.<block>']`, likewise `.sf-dock` and `.sf-layer` |
| Nodes of a block or lens view | `.sf-<kind>` (`.sf-table`, `.sf-badge`, `.sf-card`, …); `[data-role='…']` from a node's `role` prop |
| A lens block | `.sf-block[data-role='lens.plugin.<plugin>.<lens>']`, with `[data-state='running']` or `[data-state='done']` and `.failed` after a failing exit |

A plugin block's kind reaches CSS as the `data-surface` attribute of its
region elements, not as `data-role`: `data-role` belongs to the nodes inside,
which carry their own `role` props.

Give your own nodes a `role` (any node takes one) and style by it: role
names are yours, and `[data-role='myplugin.row']` won't collide with Tern's
styles. Tern's sheets color through variables such as `--accent`, `--t1` to
`--t4` (text from strongest to faintest), `--ok`, `--warn` and `--bad`;
using them keeps a plugin's styles right in light and dark themes. Paint
white text or glyphs on `--accent-fill`, the theme's accent darkened until
white reads on it; `--accent` itself is for rings, tints and borders.

### Images: `url()`

A global sheet's `url()` names a file of the plugin: a path relative to the
plugin's directory (the one holding `plugin.toml`, whatever file of `styles`
the rule is in), such as `url(icons/ts.svg)` or `url('./icons/ts.svg')`.
Tern resolves it when it installs the sheet, in manifest `styles` and
`tern.css` sheets alike, and loads it once per image however many rules and
rows use it.

- `background-image` paints SVG, PNG, JPEG, GIF, WebP, BMP, ICO and TIFF
  files (an animation's first frame), up to 4096 px a side. An SVG is
  rasterized at the display's scale; a raster's CSS size is its pixel size.
  `background-size`, `-position` and `-repeat` apply as usual.
- `data:` URLs (`data:image/svg+xml,…`, base64 or percent-encoded) work
  anywhere, also in a remote host's sheets; `url(#id)` filter references
  stay as written.
- Refused, and logged once per URL as `plugin style sheet url() …` with the
  plugin id: absolute paths, other schemes (`https:`, `file:`), `..`, links
  that lead out of the plugin's directory, missing files, and any file
  `url()` in a remote host's sheets (their files are on that host). A
  refused `url()` paints nothing; the rest of its rule applies.
- The path is literal: no percent-decoding, and `?query` or `#fragment`
  is ignored.
- `url()` also works inside custom properties (`--icon: url(a.svg)` then
  `background-image: var(--icon)`): it resolves where the property is
  declared.
- `mask-image` takes gradients only: a `url()` there parses but masks
  nothing, so tint monochrome icons by shipping them in their color.

### File icons

The Files pane's rows name their entry so a sheet can give each one its own
icon, the way VS Code icon themes do. Each row, `.ft-row`, and its icon box,
`.ft-ic` (14×14 px, holding the stock `svg.ico`), carry:

| Attribute | Value |
| --- | --- |
| `data-name` | The entry's name, lowercased: `cargo.lock`, `.env`, `foo.test.ts`. A compact folder chain's row (`crates/tern/src`) names its last folder. |
| `data-ext` | The text after the name's last dot, lowercased, without the dot: `lock`, `ts`, `gz` for `archive.tar.gz`. Empty for folders, for dotfiles such as `.env`, and for names without a dot (`justfile`) or ending in one. |
| `data-kind` | `dir` or `file` (a link counts as what it points at). |
| `data-open` | Folders only: `true` while expanded, `false` while collapsed. |

These hold for local and remote roots alike and follow the rows as they
scroll. `.ft-ic` has `background-repeat: no-repeat`, `background-position:
center` and `background-size: contain`, so a theme sets `background-image`
and hides the stock glyph:

```css
/* every file without a better match */
.ft-ic[data-kind='file'] { background-image: url(icons/file.svg); }
/* by extension */
.ft-ic[data-kind='file'][data-ext='ts'] { background-image: url(icons/typescript.svg); }
/* by a multi-part extension: a suffix match */
.ft-ic[data-kind='file'][data-name$='.test.ts'] { background-image: url(icons/test-ts.svg); }
/* by exact name */
.ft-ic[data-kind='file'][data-name='cargo.lock'] { background-image: url(icons/lock.svg); }
/* folders, collapsed and expanded, by name */
.ft-ic[data-kind='dir'] { background-image: url(icons/folder.svg); }
.ft-ic[data-kind='dir'][data-open='true'] { background-image: url(icons/folder-open.svg); }
.ft-ic[data-kind='dir'][data-name='src'] { background-image: url(icons/folder-src.svg); }
.ft-ic[data-kind='dir'][data-name='src'][data-open='true'] { background-image: url(icons/folder-src-open.svg); }
/* hide the stock glyph wherever the theme paints */
.ft-ic[data-kind] > svg.ico { display: none; }
```

Specificity decides between matches, so order a theme from general to
specific as above, the way VS Code resolves one: exact name
(`fileNames`, `folderNames` / `folderNamesExpanded`), then the longest
matching suffix (`$=` on `data-name`), then the extension
(`fileExtensions`), then the default (`file`, `folder` / `folderExpanded`).
Each attribute adds the same specificity, so give a more specific rule an
extra attribute (`[data-kind='file']`) or put it later in the sheet. Match
names lowercased: the attributes are. Generating the sheet from an icon
theme's JSON is a loop over its maps; a theme of a thousand rules costs only
the icons the visible rows use.

## Worked examples

### Tab and window titles

```lua
local function basename(path: string): string
	return string.match(path, "([^/]+)/*$") or path
end

tern.chrome.tab_title(function(tab)
	if tab.name then
		return nil
	end
	local cwd = tab.cwd or ""
	local dir = if cwd == "" then "~" else basename(cwd)
	local label = if tab.program == "" then dir else dir .. " · " .. tab.program
	if tab.panes > 1 then
		label ..= string.format(" (%d)", tab.panes)
	end
	return label
end)

tern.chrome.window_title(function(win)
	if win.tab == nil then
		return nil
	end
	return win.space .. " — " .. win.tab
end)
```

### A segment from the focused directory

The segment depends only on `pane.cwd`, which is part of the input, so the
cache is exactly right: the file is read once per directory.

```lua
local function first_word(path: string): string?
	if not tern.fs.exists(path) then
		return nil
	end
	local ok, text = pcall(tern.fs.read, path)
	if not ok then
		return nil
	end
	return string.match(text, "^%s*(%S+)")
end

tern.chrome.status(function(pane)
	local cwd = pane.cwd
	if cwd == nil or cwd == "" then
		return nil
	end
	local version = first_word(cwd .. "/.nvmrc")
	if version == nil then
		return nil
	end
	return { { text = "node " .. version, tone = "muted" } }
end)
```

### A segment fed by a process

This plugin polls `gh` every minute for the number of pull requests awaiting
review, and calls `tern.chrome.refresh()` after each answer so the segment
shows the new count. Clicking the segment runs the plugin's command.

```lua
local pending: number? = nil

local function segments(_pane: PaneInfo): { StatusSegment }?
	if pending == nil or pending == 0 then
		return nil
	end
	return {
		{ text = tostring(pending) .. " to review", icon = "branch", tone = "accent", command = "plugin.reviews.open" },
	}
end

local function poll()
	tern.process.run({ "gh", "search", "prs", "--review-requested=@me", "--state=open", "--json", "number" }, { timeout_ms = 15000 }, function(result, _cx)
		if result.status == 0 then
			local ok, list = pcall(tern.json.decode, result.stdout)
			if ok then
				pending = #list
				tern.chrome.refresh() -- drops the cached segments and redraws
			end
		end
		tern.timer(60000, poll)
	end)
end

tern.chrome.status(segments)
tern.command({
	id = "open",
	title = "Open review queue",
	run = function(cx)
		cx:open("https://github.com/pulls/review-requested")
	end,
})
poll()
```

`tern.process.run` raises on iOS; a plugin meant for iPad checks
`tern.runtime.os` first. See [Files, Processes, and Storage](io.md).

### Styling segments and a block

`plugin.toml`:

```toml
styles = ["reviews.css"]
```

`reviews.css`:

```css
#statusline .sl-plugin[data-plugin='reviews'] {
	padding: 0 6px;
	border-radius: 4px;
	background: var(--accent-fill);
	color: white;
}

.sf-main[data-surface='plugin.reviews.queue'] [data-role='reviews.stale'] {
	color: var(--t4);
}
```

And a sheet the window half switches at run time:

```lua
local compact = false

tern.command({
	id = "compact",
	title = "Toggle compact review rows",
	run = function(_cx)
		compact = not compact
		tern.css("density", if compact then ".sf-main[data-surface='plugin.reviews.queue'] .sf-item { min-height: var(--sf-lh); }" else "")
	end,
})
```

## See also

- [Building Views](views.md): node kinds, `role` and `tone` props.
- [Styling Views](../styles/index.md): the hooks of view nodes,
  [CSS variables](../styles/variables.md) and [supported CSS](../styles/css.md).
- [Commands, Keys, and Overrides](commands.md#action-names): action names
  for segment `command`s.
- [Window API](../reference/api-window.md): `TabInfo`, `PaneInfo`,
  `StatusSegment`.
- [Limits](../reference/limits.md): budgets and the styles size limit.
