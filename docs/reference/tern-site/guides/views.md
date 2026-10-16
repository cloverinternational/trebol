# Building Views

Block and lens views are trees of plain Lua tables that describe native UI
nodes: tables, lists, cards, charts, code. `tern.ui` builds them with the
same functions Tern's built-in lenses use, so a plugin's table looks and
behaves like a built-in one. This page covers the node model, the builders,
making nodes interactive, tones and styles, and `tern.parse` for reading
command output.

## Nodes

A view is a tree of nodes in the wire format of Tern's surface protocol
(TSP):

```lua
type Node = {
	k: string,              -- kind: "text", "col", "table", "badge", …
	p: { [string]: any }?,  -- props
	c: { Node }?,           -- children
}
```

Builders return these tables and nothing more, so you can inspect, change
and compose what they return before handing the tree back. Text is made of
spans: `{ t = "text", s = "style tokens", href = "link" }`. A span list
(`Spans`) is a list of spans and strings, one span, or one string.

```lua
local ui = tern.ui

local node = ui.card({ ui.span("Build", "strong") }, {
	ui.kv({
		{ "Target", { ui.span("aarch64-apple-darwin", "code") } },
		{ "Took", { ui.span("41.2s", "num") } },
	}),
	ui.progress(0.6, "linking"),
})
-- node = { k = "card", p = { head = { … } }, c = { { k = "kv", … }, { k = "progress", … } } }
```

Who receives the tree differs:

| | Block `view` | Lens `view` |
| --- | --- | --- |
| Returns | `{main?, dock?, layer?}`, one tree per region | One node, or `nil` for the raw output |
| Region root | Drawn as its children only; use a container | The node is drawn as is |
| Updates | Diffed against the last view by node id | Replaces the previous view whole |
| Node ids | `main.<key or index>…`, stable with `p.key` | Assigned by Tern; not stable |

See [Blocks](blocks.md#regions-node-ids-and-keys) for ids and keys, and
[Command Lenses](lenses.md#views-while-the-command-runs) for lens views.

## Builders

Every builder checks its arguments and raises `tern.ui.<builder>:
<argument>: <problem>` on a wrong one. [UI Builders](../reference/ui.md)
has each one's exact output.

| Purpose | Builders |
| --- | --- |
| Spans | `span(t, s?)`, `link(t, href, s?)`, `path(p, cwd?)` |
| Text | `text(spans)` |
| Layout | `col(children)` (gaps), `lines(children)` (no gaps), `row(children)`, `card(head, children)`, `section(head, children)`, `rule(label)` |
| Values | `badge(t, tone)`, `kv({ {key, value}, … })`, `meter(value, label)`, `progress(value?, label)` |
| Tables | `table(cols, rows)`, `meter_cell(value, {warn, bad}?)`, `meter_parts_cell({ {value, token}, … })` |
| Trees and lists | `tree({ {label, icon?, open?, children?}, … })`, `list({ {label, detail?, value?, icon?, tone?}, … })` |
| Text and code | `code(text, lang?, start?)`, `diff(text, path?)`, `md(text)`, `ansi(text)` |
| Charts | `bars({ {label, value}, … })`, `spark({ {label, value}, … })` |
| Results | `diagnostic(d, cwd?)`, `test_summary(passed, failed, skipped, took?)`, `overflow(hidden)` |
| Anything else | `node(kind, props?, children?)` |

A few that need more than their signature:

- **`table(cols, rows)`.** Each column is `{id, head, align?, priority?,
  grow?, truncate?}`. `rows[i][j]` is the cell of `cols[j]`: a span list or
  a meter cell. When the pane is too narrow, columns with the lowest
  `priority` hide first; `grow` shares out spare width; `truncate` says
  where a long cell is cut (`"end"`, `"start"`, `"middle"`).
- **`path(p, cwd?)`.** A path span linked to the file. Relative paths
  resolve against `cwd` (pass `run.cwd` in a lens, `cx.cwd` in a block);
  without one the span isn't linked.
- **`ansi(text)`.** A small terminal showing text with escape sequences, for
  output you don't parse.
- **`overflow(hidden)`.** The muted "… N more" line. The built-in lenses
  show at most 5,000 rows and end with it; cap your views the same way.

`node` reaches every kind the surface protocol defines, including ones no
builder covers:

```lua
ui.node("spinner", { style = "dots", label = { ui.span("Fetching", "muted") } })
ui.node("kbd", { keys = { "ctrl", "o" } })
ui.node("elapsed", { age = 1500, format = "short" })
```

[Elements](../elements/index.md) documents every kind, its props, events and
styling hooks.

## Props every node takes

| Prop | Meaning |
| --- | --- |
| `key` | Identity among siblings in a block view (see [Blocks](blocks.md#regions-node-ids-and-keys)). Local state is remembered by this key under the same parent, not surface-wide, even after deleting and adding the node with a new id; without a key, it uses the node's id |
| `tone` | Semantic color of the node's chrome (below) |
| `role` | A name of yours, exposed to CSS as `data-role` |
| `collapsible` | On `card` and `section`, `true` enables the header's disclosure control |
| `collapsed` | With `collapsible = true`, `true` starts the `card` or `section` collapsed; alone it does not fold the content |
| `actions` | What a pointer does: `{ click = "name", dblclick = "name" }` |

Builders leave `p` out when a node has no props, and the declaration types
`p` as optional, so under `--!strict` set props through a local:

```lua
local ui = tern.ui
local function with(node: Node, props: { [string]: any }): Node
	local p: { [string]: any } = node.p or {}
	for k, v in props do
		p[k] = v
	end
	node.p = p
	return node
end

local retry = with(ui.badge("Retry", "accent"), { actions = { click = "retry" }, key = "retry" })
local details = with(ui.card("Details", { ui.text("Expandable content") }), {
	collapsible = true,
	collapsed = true,
})
return ui.col({ retry, details }) -- lens view; for a block wrap in { main = ... }
```

## Actions and events

`actions` maps a pointer gesture to an action name. Some names are Tern's
own and run in the window without reaching your code; any other name is
yours and arrives as an event.

| Action | What happens | Event |
| --- | --- | --- |
| `toggle` | Tern opens or closes the collapsible node | `{ev = "toggle", id, key, collapsed}` |
| `copy` | Tern copies the node's text (its `href` when it has one) | none |
| `open` | Tern opens the node's `href` or `path` | none |
| `zoom` | Tern shows an `image` node large | none |
| `select` | Your code decides | `{ev = "select", id, item}` |
| `activate` | Your code decides (double-click) | `{ev = "activate", id, item}` |
| any other name | Your code decides | `{ev = "action", id, act, value?, mods?}` |

For `select` and `activate` on an item of a `list`, `id` is the list and
`item` the item; elsewhere both are the node.

A custom action's event is built from its name:

```lua
p.actions = { click = "sort=name" }
-- a shift-click sends:
-- { ev = "action", id = "main.0.1", act = "sort", value = "name", mods = { "shift" } }
```

- `act` is the name up to its first `=`; `value` is the rest, present only
  when the name has an `=`. Put the target of the action there (an item
  id, a column), so the handler doesn't depend on positions.
- `mods` lists the modifiers held (`"shift"`, `"ctrl"`, `"alt"`, `"meta"`),
  and is absent when none was.
- `id` is the node's id: in a block, the id the worker gave it; in a lens,
  an id Tern made up for that view.

A block's `event(state, ev, cx)` receives `action`, `select`, `activate`,
`change` and `toggle` events (and `focus` from editor nodes). A lens's `event` receives
the events of its view the same way. In both, Tern renders again after the
handler: a block runs its render cycle, a lens runs `view`.

`toggle` needs no handling: Tern already flipped the node. Because a block's
view is diffed, a `collapsed` prop that stays the same in your view doesn't
undo the user's choice. Record `ev.collapsed` only if you want to keep it
across restarts.

## Forms and controls

`tern.ui.el` draws plain elements (`div`, `label`, `button`, `form`, …) and
two controls: `input` with `type = "checkbox"` or `"radio"`. Controls are
pointer-only: a click flips them at once in the window, without waiting for
your code, and sends a `change` event. Keys stay yours. Controls work in
blocks; in a lens view they don't flip (see [HTML Elements](../elements/el.md)).

```lua
local ui = tern.ui
view = function(state, _cx)
	local function size(v)
		return ui.el("label", { class = "opt" }, {
			ui.el("input", { type = "radio", name = "size", value = v, checked = state.size == v }),
			ui.el("span", { text = v }),
		})
	end
	return { main = ui.col({
		ui.el("form", { class = "order" }, {
			size("small"), size("large"),
			ui.el("label", { class = "opt" }, {
				ui.el("input", { type = "checkbox", name = "gift", checked = state.gift }),
				ui.el("span", { text = "Gift wrap" }),
			}),
			ui.el("button", { class = "go", text = "Order", actions = { click = "order" } }),
		}),
	}) }
end,
event = function(state, ev, _cx)
	if ev.ev == "change" then
		-- { ev = "change", id, name = "size", value = "large", checked = true, values = {…} }
	elseif ev.ev == "action" and ev.act == "order" then
		state.size, state.gift = ev.values.size, ev.values.gift
	end
end,
```

Every `action`, `select`, `activate` and `change` event from a node inside an
`el` form carries `values`: the form's enabled named controls at that moment.
A radio group gives its checked `value` (nil when none is checked), a lone
checkbox a boolean, and several checkboxes sharing a name an array of the
checked ones' values. So the button's handler reads the whole form without
tracking each `change`. Radios are grouped by `name` within their form. A
click on a `label` flips the first control inside it. Setting `checked` in
your view overrides the user's choice; leaving it unchanged keeps it.

Style forms from the manifest's `styles` with the block's surface and your
own classes; a checked control matches `:checked`, a disabled one
`:disabled`:

```css
[data-surface='plugin.shop.order'] .opt {
	padding: 2px 6px;
}

[data-surface='plugin.shop.order'] .opt :checked {
	outline: 1px solid currentColor;
}
```

## Tones and span styles

A node's `tone` colors its chrome (a badge's pill, a card's edge, a list
row) from the theme: `neutral`, `accent`, `info`, `success`, `warning`,
`error`, `pending`, `muted`, `user`.

A span's `s` is a space-separated list of tokens:

| Tokens | Effect |
| --- | --- |
| `accent`, `success`, `warning`, `error`, `info`, `muted`, `dim` | Color |
| `strong`, `em` | Weight, italic |
| `code`, `mono` | Code color, monospaced face |
| `num`, `path`, `key`, `link` | Colors for numbers, paths, keys and links |
| `ins`, `del` | Added and removed text, as in diffs |
| `mark` | Highlighted, as a search match |

The full list, with omp's theme tokens and what each does, is in
[Text and Code](../elements/text.md).

Unknown tokens are ignored. Tones and tokens name roles, not colors: the
active theme supplies the colors, so a view reads right in light and dark
themes without your help.

## Styling with CSS

A plugin can add global CSS through the manifest's `styles` or `tern.css`
(see [Chrome and Styling](chrome.md#global-css)). Plugin sheets apply after
Tern's own, in every window on the machine. The hooks for view nodes:

| Element | Selector |
| --- | --- |
| A node of kind `k` | `.sf-<k>`: `.sf-table`, `.sf-badge`, `.sf-card`, `.sf-item` |
| A node with a `role` prop | `[data-role='<role>']` |
| A node with a `tone` | `[data-tone='<tone>']` |
| A span token | `.sf-t-<token>`: `.sf-t-num`, `.sf-t-del` |
| A plugin block's regions | `.sf-main[data-surface='plugin.<plugin>.<block>']`, likewise `.sf-dock` and `.sf-layer` |
| A lens block | `.sf-block[data-role='lens.plugin.<plugin>.<lens>']` |

A block's kind is the `data-surface` attribute of its region elements, not
a `data-role`. A role on a region's root node lands on the region element
itself, so `main = ui.col({ … })` with `p.role = "checklist.main"` styles as
`.sf-main[data-role='checklist.main']`.

Give your nodes roles under your plugin's id and style by them; Tern's
classes describe structure and may change between versions.

```css
/* checklist.css, listed in plugin.toml as styles = ["checklist.css"] */
.sf-main[data-surface='plugin.checklist.list'] .sf-item .sf-t-del {
	opacity: 0.6;
}

.sf-block[data-role='lens.plugin.disk.du'] .sf-table {
	font-variant-numeric: tabular-nums;
}
```

## Reading command output: `tern.parse`

`tern.parse` holds the readers the built-in lenses use for shapes many
commands share. They work in both halves.

| Function | Reads |
| --- | --- |
| `columns(lines) -> {head, rows}?` | A whitespace-aligned table whose first non-blank line is the header (`docker ps`, `kubectl get`, `ps aux`, `df`). Columns split where every line is blank, so right-aligned numbers and multi-word headers (`Mounted on`) stay whole. `nil` for prose or rows that don't line up |
| `packed(lines) -> {string}` | Entries of `ls`-style output packed into columns |
| `json_tree(text) -> Node?` | A JSON document, or a stream of them, as a collapsible tree; `nil` when it isn't JSON |
| `location(s) -> (path?, line?, col?)` | `file:line[:col]` at the start of `s`, as compilers and `grep -n` print |
| `size(s) -> number?` | A human size in bytes: `4.0K` and `1.2Gi` count in 1024s, `1.2GB` and `512kB` in 1000s, `512` and `512B` are bytes |

`columns` needs the whole table to find the column edges, so collect lines
in `line` and parse in `view`. This lens shows `df` as a table with a meter
for every percentage cell:

```toml
[[lenses]]
id = "df"
match = ["df", "df *"]
```

```lua
--!strict
local ui = tern.ui

type DfState = { lines: { string } }

local function percent(cell: string): number?
	local n = string.match(cell, "^(%d+)%%$")
	return if n then tonumber(n) else nil
end

local df: LensDef<DfState> = {
	open = function(_run, _cx)
		return { lines = {} }
	end,
	line = function(state, l)
		table.insert(state.lines, l.text)
	end,
	finish = function(_state, _status) end,
	view = function(state)
		local t = tern.parse.columns(state.lines)
		if not t then
			return nil
		end
		local cols: { Col } = {}
		for j, head in t.head do
			cols[j] = { id = "c" .. j, head = head, align = if j > 1 and j < #t.head then "end" else nil }
		end
		local rows: { { Cell } } = {}
		for i, cells in t.rows do
			local row: { Cell } = {}
			for j, cell in cells do
				local pct = percent(cell)
				row[j] = if pct then ui.meter_cell(pct / 100, { 0.8, 0.95 }) else cell
			end
			rows[i] = row
		end
		return ui.table(cols, rows)
	end,
}

tern.lens.define("df", df)
```

The header decides the columns, so the same code reads macOS's `df -h`
(with `Capacity`, `iused` and `%iused`) and Linux's (with `Use%`). The
meters turn warning-colored at 80% and error-colored at 95%. Lines that
don't form a table make `columns` return `nil`, and the lens falls back to
the raw output.

## Related pages

- [UI Builders](../reference/ui.md): every builder's exact output and
  argument errors.
- [Elements](../elements/index.md): every node kind, its props, events and
  DOM.
- [Styling Views](../styles/index.md): every style hook, CSS variable and
  supported CSS feature.
- [Blocks](blocks.md) and [Command Lenses](lenses.md): where views go.
- [Chrome and Styling](chrome.md): sheets, the cascade, status segments.
