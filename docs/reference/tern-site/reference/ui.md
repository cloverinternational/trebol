# UI Builders

`tern.ui` builds the nodes plugin views are made of, and `tern.parse` reads
command output into the shapes those builders take. Both exist in both
contexts and are the same code Tern's built-in lenses use, so a plugin's table looks
exactly like a built-in one. Blocks return nodes from `view` per region;
lenses return one node from `view`. See [Building Views](../guides/views.md).

## Nodes and spans

Every builder returns a plain Lua table you may inspect and change before
returning it.

```lua
type Node = {
	k: string,               -- kind: "text", "col", "table", …
	p: { [string]: any }?,   -- props (absent when empty)
	c: { Node }?,            -- children (absent when empty)
}

type Span = {
	t: string,               -- text
	s: string?,              -- space-separated style tokens
	href: string?,           -- link target
	fx: string?,             -- effect: "shimmer", "pulse" or "none"
}

type Spans = { Span | string } | string
```

Props every node takes:

| Prop | Meaning |
| --- | --- |
| `key` | Identity among its siblings: keeps the node's id across reorders. Local state is remembered by this key under its parent, not surface-wide, and survives deleting and adding a node with a new id and the same key under the same parent. Without a key, local state uses the node's id. Siblings must not share a key; the same key under another parent has independent state |
| `tone` | Semantic color: `accent`, `success`, `warning`, `error`, `info`, `muted`, … |
| `role` | A role string exposed as `data-role` for CSS |
| `collapsible` | On `card` and `section`, `true` enables the header's disclosure control |
| `collapsed` | With `collapsible = true`, `true` starts the `card` or `section` collapsed; alone it does not fold the content |
| `actions` | Pointer actions, e.g. `{ click = "name" }`; a custom name arrives as event `{ ev = "action", act = "name" }` (blocks and lenses) |

Set props through `p`, creating it when the builder left it out:

```lua
local node = tern.ui.badge("Retry", "accent")
local p: { [string]: any } = node.p or {}
p.actions = { click = "retry" }
p.key = "retry"
node.p = p
```

To make a card initially folded and let the user expand it, set both props
(the same applies to `section`):

```lua
local ui = tern.ui
local details = ui.card("Details", { ui.text("Expandable content") })
local p: { [string]: any } = details.p or {}
p.collapsible = true
p.collapsed = true
details.p = p
return details -- lens view; for a block use { main = ui.col({ details }) }
```

### Argument conversion

The builders check their arguments and raise `tern.ui.<builder>: <argument>:
<problem>`, naming the argument path (`cols[2].align`, `rows[3][1]`,
`items[1].label`). Common problems:

| Message tail | Cause |
| --- | --- |
| `expected a string, got <type>` | A non-string where text goes (numbers are accepted and converted) |
| `expected a number, got <type>` | |
| `expected an integer in <min>..=<max>, got <n>` | A fractional or out-of-range count, line or column |
| `expected a boolean, got <type>` | |
| `expected a list, got <type>` | A list argument that isn't a table (`nil` counts as an empty list) |
| `expected a table, got <type>` | |
| `expected a {a, b} pair, got <type>` | A pair argument (`kv` items, series points) that isn't a table |
| ``expected a span (a table with a string `t`)`` | A table in a span list without `t` |
| `expected a span or a string, got <type>` | |
| `expected a list of nodes, got one node (wrap it in {})` | A single node where children go |
| ``expected a node (a table with a string `k`)`` | |
| `expected a table of props, got <type>` | `node` props that are not a map |

A span list (`Spans`) is a list of spans and strings in order, one span
table, or one string; `nil` is empty. Strings become unstyled spans.

## Spans

### `span`

```lua
tern.ui.span: (t: string, s: string?) -> Span
```

A span of `t`. `s` is space-separated style tokens (`"muted"`,
`"strong error"`, `"num"`, `"code"`, `"path"`); absent or `""` is plain.
Output: `{ t = t, s = s }` (no `s` when plain).

### `link`

```lua
tern.ui.link: (t: string, href: string, s: string?) -> Span
```

A span of `t` linking to `href`. Output: `{ t, s?, href }`. A click goes
through the window's link handling, including `tern.route.link`.

### `path`

```lua
tern.ui.path: (p: string, cwd: string?) -> Span
```

A `path`-styled span showing `p` and linking to its absolute `file://` URL.
A relative `p` resolves against `cwd`; with no `cwd`, or for a `~` path, the
span is not linked. Output: `{ t = p, s = "path", href = "file:///…" }`.

```lua
tern.ui.text({ tern.ui.span("see "), tern.ui.path("src/main.rs", run.cwd) })
```

## Layout

| Builder | Signature | Output |
| --- | --- | --- |
| `text` | `(spans: Spans) -> Node` | `{k = "text", p = {spans}}` |
| `col` | `(children: { Node }) -> Node` | `{k = "col", p = {gap = "sm"}, c}`: a vertical stack with small gaps |
| `lines` | `(children: { Node }) -> Node` | `{k = "col", p = {gap = "none"}, c}`: lines of one text stream, no gaps |
| `row` | `(children: { Node }) -> Node` | `{k = "row", p = {gap = "sm"}, c}`: a horizontal row |
| `card` | `(head: Spans, children: { Node }) -> Node` | `{k = "card", p = {head}, c}` |
| `section` | `(head: Spans, children: { Node }) -> Node` | `{k = "section", p = {head}, c}`: a lighter disclosure group |
| `rule` | `(label: Spans) -> Node` | `{k = "rule", p = {label?}}`: a divider, labeled when `label` isn't empty (`rule()` is bare) |

A `gap` prop overrides the spacing of `col` and `row`: `none`, `xs`, `sm`,
`md`, `lg`.

```lua
tern.ui.card({ tern.ui.span("Build", "strong"), tern.ui.span(" "), tern.ui.span("3 warnings", "warning") }, {
	tern.ui.lines({ tern.ui.text("first line"), tern.ui.text("second line") }),
})
```

## Values

### `badge`

```lua
tern.ui.badge: (t: string, tone: string) -> Node
```

A pill chip. Output `{k = "badge", p = {text = t, tone}}`. The runtime
accepts a missing `tone` (a plain badge).

### `kv`

```lua
tern.ui.kv: (items: { { Spans } }) -> Node
```

An aligned key/value list. Each item is a pair `{ keySpans, valueSpans }`.
Output `{k = "kv", p = {items = {{k = spans, v = spans}, …}}}`.

```lua
tern.ui.kv({ { "context", tern.ui.span("prod", "error strong") }, { "namespace", "default" } })
```

### `meter`

```lua
tern.ui.meter: (value: number, label: Spans) -> Node
```

A meter at `value`, clamped to 0–1, labeled `label`. Output
`{k = "meter", p = {value, label}}`.

### `progress`

```lua
tern.ui.progress: (value: number?, label: Spans) -> Node
```

A progress bar at `value` (clamped to 0–1); `nil` is indeterminate. Output
`{k = "progress", p = {value, label}}`.

### `bars`, `spark`

```lua
tern.ui.bars: (series: { { any } }) -> Node
tern.ui.spark: (series: { { any } }) -> Node
```

A bar chart or a sparkline of `{ label, value }` pairs (`label` a string or
number, `value` a number). Output
`{k = "chart", p = {kind = "bars" | "spark", series = {{value = value, label = label}, …}}}`.

```lua
local series: { { any } } = {}
for i, ms in timings do
	series[i] = { tostring(i), ms }
end
return tern.ui.spark(series)
```

### `test_summary`

```lua
tern.ui.test_summary: (passed: number, failed: number, skipped: number, took: string?) -> Node
```

A row with a stacked pass/fail/skip meter and the counts (`3 passed · 1
failed · 1.2s`), toned `error` when `failed > 0`, else `success`. The counts
are non-negative integers.

### `overflow`

```lua
tern.ui.overflow: (hidden: number) -> Node
```

A muted text line `… N more (Raw shows everything)`. Use it when a lens
shows only part of long output.

## Tables

### `table`

```lua
tern.ui.table: (cols: { Col }, rows: { { Cell } }) -> Node

type Col = {
	id: string,
	head: string,
	align: ("start" | "center" | "end")?,
	priority: number?,
	grow: number?,
	truncate: ("end" | "start" | "middle")?,
}

type Cell = Spans | MeterCell
```

`rows[i][j]` is the cell of `cols[j]`; extra cells are ignored, missing ones
are empty.

| Column field | Default | Meaning |
| --- | --- | --- |
| `id` | required | Id the row's cells are keyed by; a later column with the same id wins |
| `head` | required | Header text |
| `align` | `"start"` | Cell alignment; `"end"` for numbers. Other values raise ``unknown align "<v>" (start\|center\|end)`` |
| `priority` | `0` | Columns with the lowest priority hide first when the table is narrow (an integer) |
| `grow` | `0` | Share of the spare width this column takes |
| `truncate` | `"end"` | Where a cell that doesn't fit is cut: `"end"` keeps the start (`abcd…`), `"start"` keeps the end (`…wxyz`), `"middle"` keeps both ends (paths drop directories first). Other values raise ``unknown truncate "<v>" (end\|start\|middle)`` |

Output: `{k = "table", p = {cols = {{id, head, align, truncate, priority,
grow}, …}, rows = {{id = "r0", cells = {[colId] = cell}}, …}}}`. Rows get ids
`r0`, `r1`, … in order.

```lua
tern.ui.table({
	{ id = "name", head = "Pod", grow = 1, truncate = "middle" },
	{ id = "cpu", head = "CPU", align = "end", priority = 1 },
	{ id = "mem", head = "Memory", priority = 2 },
}, {
	{ "api-7d9f", "120m", tern.ui.meter_cell(0.42, { 0.7, 0.9 }) },
	{ tern.ui.span("worker-1", "muted"), "15m", tern.ui.meter_cell(0.91, { 0.7, 0.9 }) },
})
```

### `meter_cell`

```lua
tern.ui.meter_cell: (value: number, thresholds: { number }?) -> MeterCell
```

A thin-bar cell at `value` (clamped to 0–1). `thresholds` is a pair
`{ warn, bad }`: the fill is tinted `warn` at or above the first and `bad` at
or above the second.

### `meter_parts_cell`

```lua
tern.ui.meter_parts_cell: (parts: { { any } }) -> MeterCell
```

A thin-bar cell stacking parts from the left; each part is
`{ value, themeToken }` with `value` clamped to 0–1 and `themeToken` a theme
color token (`"success"`, `"error"`, `"toolDiffAdded"`, …).

```lua
type MeterCell = {
	meter: {
		value: number?,
		thresholds: { warn: number, bad: number }?,
		parts: { { value: number, token: string, label: string?, hatch: boolean? } }?,
		tone: string?,
		title: string?,
	},
}
```

Both return this shape (`value` and `thresholds` for `meter_cell`, `parts`
for `meter_parts_cell`). Set `cell.meter.tone` to tint a cell. A table cell
is read as a meter cell whenever it is a table with a `meter` field, so a
hand-built `{ meter = { … } }` works too.

## Trees and lists

### `tree`

```lua
tern.ui.tree: (nodes: { TreeNode }) -> Node

type TreeNode = {
	label: Spans,
	icon: string?,
	open: boolean?,
	children: { TreeNode }?,
}
```

A disclosure tree. `open` (default `false`) says whether a node's children
show; it is emitted only for nodes with children. Output
`{k = "tree", p = {nodes = {{id = "t0", label, icon?, open?, children?}, …}}}`;
ids `t0`, `t1`, … are assigned depth-first and are unique in the tree.

```lua
tern.ui.tree({
	{ label = "src", icon = "folder", open = true, children = {
		{ label = "main.rs", icon = "file" },
	} },
})
```

### `list`

```lua
tern.ui.list: (items: { Item }) -> Node

type Item = {
	label: Spans,
	detail: Spans?,
	value: Spans?,
	icon: string?,
	tone: string?,
}
```

A list of rows: `label`, secondary `detail` after it, a right-aligned
`value`, a named `icon`, and the row's `tone`. Output
`{k = "list", c = {{k = "item", p = {label, detail?, value?, icon?, tone?}}, …}}`.

```lua
tern.ui.list({
	{ label = "main", detail = "origin/main", value = tern.ui.span("↑2", "num"), icon = "git-branch" },
	{ label = "fix-login", tone = "warning" },
})
```

## Text and code

| Builder | Signature | Output |
| --- | --- | --- |
| `code` | `(text: string, lang: string?, start: number?) -> Node` | `{k = "code", p = {text, lang?, start?, numbers?}}`: highlighted code in `lang` (a file extension or language name); with `start`, line numbers show from it |
| `diff` | `(text: string, path: string?) -> Node` | `{k = "diff", p = {text, path?}}`: a unified diff, `path` picking the grammar |
| `md` | `(text: string) -> Node` | `{k = "md", p = {text}}`: Markdown |
| `ansi` | `(text: string) -> Node` | `{k = "ansi", p = {text}}`: a mini terminal rendering ANSI escape sequences |

`text`, `md`, `code` and `ansi` are text kinds, as are `math`, `editor`,
`input`, `shimmer` and `el` (see [Elements](../elements/index.md#every-kind)):
in a block, a `text` prop that grows by a suffix is sent as an append. See
[Host API](api-host.md#view-model).

## Diagnostics

### `diagnostic`

```lua
tern.ui.diagnostic: (d: Diag, cwd: string?) -> Node

type Diag = {
	severity: ("error" | "warning" | "note" | "help")?,
	code: string?,
	message: string,
	path: string?,
	line: number?,
	col: number?,
	snippet: { any }?,
	notes: { string }?,
	suggestions: { { any } }?,
}
```

A compiler or linter diagnostic as a card.

| Field | Default | Meaning |
| --- | --- | --- |
| `severity` | `"error"` | Tone: `error` → error, `warning` → warning, `note` → info, `help` → muted. Other values raise ``unknown severity "<v>" (error\|warning\|note\|help)`` |
| `code` | none | Lint or error code, shown as a code span (`E0308`) |
| `message` | required | The message |
| `path` | none | File as printed; the location links to it, a relative path resolving against `cwd` |
| `line`, `col` | none | 1-based position, shown as `:line:col` and added to the link (`#L12C4`) |
| `snippet` | none | `{ firstLine, source }`: an excerpt with line numbers from `firstLine`, the diagnostic's line marked in its tone |
| `notes` | none | Muted lines under the excerpt |
| `suggestions` | none | `{ { message, firstLine, code }, … }`: each a muted message over a code excerpt |

The card is toned by severity and keyed `path:line:col:code`, so a list of
diagnostics keeps identity across updates. Highlighting uses the extension
of `path`.

```lua
tern.ui.diagnostic({
	severity = "warning",
	code = "unused_variables",
	message = "unused variable: `x`",
	path = "src/lib.rs",
	line = 4,
	col = 9,
	snippet = { 3, "fn f() {\n    let x = 1;\n}" },
	notes = { "if this is intentional, prefix it with an underscore: `_x`" },
}, run.cwd)
```

## Any node

### `node`

```lua
tern.ui.node: (kind: string, props: { [string]: any }?, children: { Node }?) -> Node
```

Any surface protocol node kind: `{k = kind, p = props, c = children}`, with
`p` and `c` left out when empty. Use it for kinds without a builder (`image`
with a `blob` prop from `cx:blob`, `spacer`, …). [Elements](../elements/index.md)
documents every kind and its props; an unknown kind is rejected by Tern when
the node is shown, not by the builder.

```lua
local id = cx:blob(tern.fs.read("chart.png"), "image/png")
return { main = tern.ui.col({ tern.ui.node("image", { blob = id, alt = "Chart" }) }) }
```

### `el`

```lua
tern.ui.el: (tag: string, props: { [string]: any }?, children: { Node }?) -> Node
```

A generic element: `{k = "el", p = {tag = tag, …props}, c = children}`. The
tags are `div span p section header footer nav aside main article figure
blockquote ul ol li dl dt dd h1 h2 h3 h4 pre code kbd strong em b i del mark
hr table thead tbody tr th td label button form input`. `form` draws as a
`div` and groups the controls inside it. Any other tag draws as a `div`, and
Tern reports it once as an `error` event (`unknown el tag <tag>`).

| Prop | Meaning |
| --- | --- |
| `class` | Space-separated classes for your CSS |
| `attrs` | `data-*`, `aria-*`, `role`, `colspan`, `rowspan` attributes (string, number or boolean values); others are ignored |
| `text` | Plain text drawn before the children |

Common props (`role`, `key`, `actions`, `hidden`, `title`, …) apply as on any
node. `input` and `hr` take no children.

`input` is a pointer-only control with `type = "checkbox"` or `"radio"` (any
other type counts as an unknown tag), `name`, `value` (default `"on"`),
`checked` and `disabled`. A click flips it and sends `{ev = "change", id,
name?, value, checked, values?}`; see [Forms and
controls](../guides/views.md#forms-and-controls).

```lua
tern.ui.el("label", {}, {
	tern.ui.el("input", { type = "checkbox", name = "all", checked = true }),
	tern.ui.el("span", { text = "Show all" }),
})
```

## Parsers

`tern.parse` raises `tern.parse.<f>: lines: expected a list of strings, got
<type>`, `tern.parse.<f>: lines[<i>]: expected a string, got <type>`, or
`tern.parse.<f>: <arg>: expected a string, got <type>` for bad arguments.
Unlike `tern.ui`, it does not accept numbers for strings.

### `parse.columns`

```lua
tern.parse.columns: (lines: { string }) -> Columns?

type Columns = {
	head: { string },
	rows: { { string } },
}
```

Reads whitespace-aligned output (`ps`, `df`, `kubectl get`, `docker ps`):
blank lines are skipped and the first line is the header. Columns split only
at display columns blank in every line, so a right-aligned column takes the
gap before its header and multi-word headers (`CONTAINER ID`, `Mounted on`)
stay whole. Cells are trimmed. Returns `nil` when fewer than two columns
remain or no two header words are two blanks apart (prose).

```lua
local t = tern.parse.columns(state.lines)
if t then
	local cols = {}
	for i, h in t.head do
		cols[i] = { id = tostring(i), head = h }
	end
	return tern.ui.table(cols, t.rows)
end
return nil
```

### `parse.packed`

```lua
tern.parse.packed: (lines: { string }) -> { string }
```

The entries of a packed multi-column listing (`ls`, git's `column.ui`), read
down each column then across. Without columns, each line is one entry. An
entry holding a space stays whole unless every row breaks there.

### `parse.json_tree`

```lua
tern.parse.json_tree: (text: string) -> Node?
```

A JSON document as a collapsible tree node, objects and arrays open to depth
2; a stream of documents (`jq '.[]'`) shows one node per document. Keys are
toned `info`, strings `success`, numbers `num`, booleans and null `accent`;
past 5000 nodes the rest is summarized. Returns `nil` when `text` is not
JSON, or is a stream of scalars only.

### `parse.location`

```lua
tern.parse.location: (s: string) -> (string?, number?, number?)
```

`file:line[:col]` at the start of `s`: returns path, line and column (`nil`
column when absent), or a single `nil`.

```lua
local path, line, col = tern.parse.location("src/main.rs:12:5: error: x")
-- "src/main.rs", 12, 5
```

### `parse.size`

```lua
tern.parse.size: (s: string) -> number?
```

A human size in bytes, or `nil`. A bare unit letter (`4.0K`, `1.2G`, as
`ls`, `du` and `df` print) and `Ki`/`KiB` are powers of 1024; a unit with `B`
(`kB`, `MB`, `1.2GB`, as `docker` and `pip` print) is decimal. `"4.0K"` is
4096; `"1.2GB"` is 1200000000; `"-"` and `""` are `nil`.

## Related pages

- [Building Views](../guides/views.md) for layout patterns.
- [Host API](api-host.md) for how block and lens views are sent.
