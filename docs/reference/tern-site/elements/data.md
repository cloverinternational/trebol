# Data

Data kinds show structured values: key/value pairs, tables, disclosure trees, and the small inline chips that sit
inside them (badges, keycaps, icons, images). Reach for `kv` for a handful of labeled values, `table` for rows that
share columns, `tree` for nested items the user opens and closes, and `badge`, `kbd`, `icon` inside rows, cards and
headers.

| Kind | Builder | Draws |
| --- | --- | --- |
| [`kv`](#kv) | `tern.ui.kv(items)` | An aligned key/value grid, or one inline `k v · k v` line |
| [`table`](#table) | `tern.ui.table(cols, rows)` | A column grid that hides low-priority columns when narrow; text or meter cells |
| [`tree`](#tree) | `tern.ui.tree(nodes)` | A disclosure tree with guides and turning chevrons |
| [`badge`](#badge) | `tern.ui.badge(text, tone)` | A tone-tinted pill |
| [`kbd`](#kbd) | `tern.ui.node("kbd", { keys = … })` | Keycaps with platform glyphs (`⌃` `⇧` `⏎`) |
| [`icon`](#icon) | `tern.ui.node("icon", { name = … })` | One icon from Tern's set |
| [`image`](#image) | `tern.ui.node("image", { blob = … })` | A PNG, JPEG, GIF, WebP or SVG image (animations play), with children drawn over it; click to zoom |

Every kind also takes the common props (`id`, `role`, `tone`, `actions`, `min`/`max`, …): see
[Elements](index.md). Every node is `<tag class="sf sf-<kind>" data-id="<id>">`. The stable styling hooks are
`.sf-<kind>`, `[data-id]`, `[data-role]`, `[data-tone]`, and the region's `[data-surface]`. The inner classes listed
below (`.sf-kv-k`, `.sf-tbl-c`, …) are Tern's structure: they are documented so you can style them, but they are
inner and may change between versions. See [Styling views](../styles/index.md) for sheets and the cascade.

Apart from `image`, which draws its children over the picture, none of these kinds draws children: children of a
`kv`, `table`, `tree`, `badge`, `kbd` or `icon` are ignored.

## `kv`

A list of key/value pairs. The default `grid` layout is a two-column grid: keys in the muted `--t3` color, no wrap;
values wrap anywhere (`white-space: pre-wrap`). The key column is as wide as the widest key in the source, in
terminal cells, so the values line up even when only part of a long list is mounted. The `inline` layout puts every
pair on one wrapping line, `key value · key value`, with nothing wrapping inside a pair.

Keys and values are spans: a string, or a list of spans with style tokens (see [Text](text.md)).

A long grid-layout `kv` in the transcript mounts only the pairs in view plus a few beyond each edge, between
invisible spacers (`.sf-data-pad`) that keep the scroll height. Pairs patch in place when their text changes. Copying
the whole view still captures every pair.

**Build it:** `tern.ui.kv(items)` (see [UI Builders](../reference/ui.md#kv)), or
`tern.ui.node("kv", { items = { { k = …, v = … } }, layout = "inline" })`. The builder has no `layout` argument: set
`node.p.layout = "inline"` on its result, or use `tern.ui.node`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `items` | `{ { k: Spans, v: Spans } }` | `{}` | The pairs, in order. Position is identity: pairs have no ids |
| `layout` | `"grid"` \| `"inline"` | `"grid"` | `"inline"` draws one wrapping line; any other value is the grid |

**Children:** none (ignored).

**Events:** none of its own; `actions` work as on any node.

**Styling:**

```html
<div class="sf sf-kv" data-id="…">            <!-- .inline with layout = "inline" -->
	<div class="sf-data-pad sf-hidden" aria-hidden="true"></div>
	<div class="sf-kv-item first">
		<span class="sf-kv-sep" aria-hidden="true">·</span>
		<div class="sf-kv-k">context</div>
		<div class="sf-kv-v">prod</div>
	</div>
	<div class="sf-kv-item">…</div>
	<div class="sf-data-pad sf-hidden" aria-hidden="true"></div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-kv` |
| Inline layout | `.sf-kv.inline` |
| One pair | `.sf-kv-item` (inner, may change; `display: contents` in the grid) |
| The first pair | `.sf-kv-item.first` (inner; its separator is hidden) |
| Key | `.sf-kv-k` (inner, may change) |
| Value | `.sf-kv-v` (inner, may change) |
| The `·` between inline pairs | `.sf-kv-sep` (inner; `display: none` in the grid) |
| Spacers for unmounted pairs | `.sf-data-pad` (inner; `.sf-hidden` when empty) |

The grid sets `column-gap: 14px` and `row-gap: 1px`. In the transcript Tern writes `grid-template-columns` inline
(the widest key in px, then `minmax(0, 1fr)`), so a sheet that changes the key column needs `!important` or a
different `column-gap`. Keys use `--t3`, the inline separator `--t4` (see [Variables](../styles/variables.md)).

```lua
local ui = tern.ui

return ui.kv({
	{ "context", ui.span("prod", "error strong") },
	{ "namespace", "default" },
	{ "pods", ui.span("12 running", "success") },
})
```

An inline summary line:

```lua
local line = ui.kv({ { "branch", "main" }, { "ahead", "2" }, { "dirty", "yes" } })
line.p.layout = "inline"
return line
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-data-kv.light.png" srcset="../figures/elements-data-kv.light.png 2x" alt="A kv grid with keys context, namespace and pods aligned in a muted column, above an inline kv line reading branch main · ahead 2 · dirty yes">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-data-kv.dark.png" srcset="../figures/elements-data-kv.dark.png 2x" alt="A kv grid with keys context, namespace and pods aligned in a muted column, above an inline kv line reading branch main · ahead 2 · dirty yes">
<figcaption>The grid layout (top) and the inline layout (bottom).</figcaption>
</figure>

## `table`

A grid of rows under named columns, with a small sans header and hairlines between rows. Rows are keyed by `id`,
so a row whose cells change patches in place and the others stay mounted.

**Column sizing.** Tern measures each column's natural width: its widest cell (in characters of the cell font; a
meter cell counts as 8) plus the 14px cell padding, or its header as drawn, whichever is wider. When the columns do
not fit the table's width, columns hide, lowest `priority` first (a missing priority is `0`; ties hide the rightmost
first), until the rest fit or one column is left. For this test a `grow` column counts as at most 24 characters wide:
a long `grow` column cuts its cells rather than pushing other columns out. Spare width goes to the `grow` columns, in
proportion to their shares; without any `grow` column the table keeps its natural width. When the shown columns
still overflow, the `grow` columns give up width first (each down to 24 characters), then every column shrinks in
proportion. Sizing reruns when the table resizes.

**Truncation.** A cell never wraps. When it is wider than its column it is cut with an ellipsis per its column's
`truncate`: `end` keeps the start (`abcd…`, by CSS `text-overflow`), `start` keeps the end (`…wxyz`), `middle` keeps
both ends (paths drop directories first).

**Meter cells.** A cell `{ meter = { … } }` is a thin bar across the cell instead of text, read the way the `meter`
kind reads the same props (see [Motion](motion.md#meter)). It is 8 cells wide naturally and as wide as the column in
a `grow` column. Hovering it shows its `title`.

**Long tables.** In the transcript a long table mounts only the rows in view and a few beyond each edge (rows have a
fixed stride: one line plus 6px), between `.sf-data-pad` spacers that keep the scroll height. Copying the whole view
still captures every row.

**Rows are not selectable.** A table has no row selection, no row events and no per-row actions: `rows` entries
are data, not nodes. For clickable rows use a [`list`](lists.md#list) of `item`s, or put `actions` on the table node
itself.

**Build it:** `tern.ui.table(cols, rows)` with `tern.ui.meter_cell` / `tern.ui.meter_parts_cell` for meter cells
(see [UI Builders](../reference/ui.md#table)), or `tern.ui.node("table", { cols = …, rows = … })`. The builder gives
rows the ids `r0`, `r1`, …; build the props yourself when you want stable row ids that survive reordering.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cols` | `{ Col }` | `{}` | The columns, left to right. An entry without an `id` is skipped |
| `rows` | `{ Row }` | `{}` | The rows, top to bottom. A row without an `id`, or with an `id` already used, is skipped |

`Col` fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | string | required | The key of this column's cell in each row's `cells` |
| `head` | Spans | none | Header text. The header row exists only when some column has a non-empty `head` |
| `align` | `"start"` \| `"center"` \| `"end"` | `"start"` | Text alignment of the header and the cells; `"end"` for numbers. Other values read as `"start"` |
| `truncate` | `"end"` \| `"start"` \| `"middle"` | `"end"` | Where a cell that doesn't fit is cut |
| `priority` | number | `0` | Lower hides first when the table is too narrow |
| `grow` | number | `0` | Share of the spare width; `0` or less never grows |

`Row` fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | string | required | Row identity, unique in the table (shown as `data-key`) |
| `cells` | `{ [colId]: Spans \| MeterCell }` | `{}` | One cell per column id; a missing cell is empty; keys that match no column are ignored |

`MeterCell` is `{ meter = { … } }`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `value` | number | sum of `parts`, else unknown | Fill, clamped to 0–1. With neither `value` nor `parts` the bar is empty and marked `.unknown` |
| `parts` | `{ { value, token, label?, hatch? } }` | none | Stacked fills from the left; values clamp so they sum to at most 1. `token` is a theme color token (`success`, `error`, `toolDiffAdded`, …), `label` names the part in the tooltip, `hatch = true` stripes it |
| `thresholds` | `{ warn: number?, bad: number? }` | none | Sets `data-level="warn"` at or above `warn`, `"bad"` at or above `bad`, tinting the fill |
| `tone` | tone | none | Tints the fill: one of `neutral`, `accent`, `info`, `success`, `warning`, `error`, `pending`, `muted`, `user`; other values are ignored |
| `title` | string | labeled parts | Tooltip; without it, the labeled parts and their shares (`used 42% · cache 8%`) |

**Children:** none (ignored).

**Events:** none of its own; `actions` work as on any node.

**Styling:**

```html
<div class="sf sf-table" data-id="…">
	<div class="sf-tbl" role="table" aria-rowcount="3">
		<div class="sf-tbl-row head" role="row" aria-rowindex="1">
			<div class="sf-tbl-h" role="columnheader">Pod</div>
			<div class="sf-tbl-h ta-end" role="columnheader">CPU</div>
			<div class="sf-tbl-h off" role="columnheader">Memory</div>   <!-- hidden by priority -->
		</div>
		<div class="sf-data-pad sf-hidden" aria-hidden="true"></div>
		<div class="sf-tbl-row" role="row" aria-rowindex="2" data-key="api">
			<div class="sf-tbl-c" role="cell">api-7d9f</div>
			<div class="sf-tbl-c ta-end" role="cell">120m</div>
			<div class="sf-tbl-c meter off" role="cell">
				<div class="sf-meter" data-style="bar" data-size="sm" data-level="warn" data-tone="…"
					role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="72" title="…">
					<div class="sf-mt-track"><div class="sf-mt-fill"></div></div>
				</div>
			</div>
		</div>
		<div class="sf-tbl-row last" role="row" aria-rowindex="3" data-key="worker">…</div>
		<div class="sf-data-pad sf-hidden" aria-hidden="true"></div>
	</div>
	<div class="sf-tbl-probe" aria-hidden="true">…</div>   <!-- hidden, measured for sizing -->
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-table` |
| The grid | `.sf-tbl` (inner, may change) |
| Header row / one row | `.sf-tbl-row.head` / `.sf-tbl-row` (inner; `display: contents`, so style the cells) |
| A row by id | `.sf-tbl-row[data-key='api']` (inner) |
| The last row | `.sf-tbl-row.last` (inner; its cells drop the hairline) |
| Header cell / cell | `.sf-tbl-h` / `.sf-tbl-c` (inner, may change) |
| Aligned cells | `.ta-center`, `.ta-end` (inner) |
| Hidden column | `.sf-tbl-h.off`, `.sf-tbl-c.off` (inner; `display: none`) |
| Meter cell | `.sf-tbl-c.meter` (inner); its bar `.sf-meter`, `.sf-mt-track`, `.sf-mt-fill`, `.sf-mt-part` |
| Meter level / tone | `.sf-meter[data-level='warn' \| 'bad']`, `.sf-meter[data-tone]`, `.sf-meter.unknown` |
| Spacers | `.sf-data-pad` (inner) |
| Width probe | `.sf-tbl-probe` (inner; never visible, don't style it) |

Cells are `padding: 3px 7px` with a `var(--l1)` hairline (`box-shadow: inset 0 -1px 0`); header cells are 24px,
`500 11.5px` sans in `--t3` over a `var(--l2)` hairline. The grid overhangs the node by 7px on each side so cell text
lines up with the surrounding text. Column widths are inline `grid-template-columns` set by Tern; change cell
padding with care, since sizing assumes 14px per cell. Row selectors such as `:nth-child` see the spacer and the
header too: target `[data-key]` or `.last` instead.

```lua
local ui = tern.ui

local pods = {
	{ name = "api-7d9f8c6b5-x2kqp", cpu = 120, mem = 0.42 },
	{ name = "worker-5c8d7f9b4-m7lzt", cpu = 860, mem = 0.76 },
	{ name = "scheduler-6b9c4d8f7-qq8rn", cpu = 35, mem = 0.93 },
}
local rows = {}
for i, pod in pods do
	rows[i] = {
		id = pod.name,
		cells = {
			name = pod.name,
			cpu = string.format("%dm", pod.cpu),
			mem = { meter = {
				value = pod.mem,
				thresholds = { warn = 0.7, bad = 0.9 },
				title = string.format("%d%% of 2Gi", math.floor(pod.mem * 100)),
			} },
		},
	}
end
return ui.node("table", {
	cols = {
		{ id = "name", head = "Pod", grow = 1, truncate = "middle", priority = 3 },
		{ id = "cpu", head = "CPU", align = "end", priority = 1 },
		{ id = "mem", head = "Memory", grow = 1, priority = 2 },
	},
	rows = rows,
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-data-table.light.png" srcset="../figures/elements-data-table.light.png 2x" alt="The pod table twice: at full width with Pod, CPU and Memory columns and meter bars in blue, amber and red; at 300px wide the CPU column is hidden">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-data-table.dark.png" srcset="../figures/elements-data-table.dark.png 2x" alt="The pod table twice: at full width with Pod, CPU and Memory columns and meter bars in blue, amber and red; at 300px wide the CPU column is hidden">
<figcaption>The same table at 560px and at 300px: CPU (priority 1) hides first. The bars cross the <code>warn</code> and <code>bad</code> thresholds.</figcaption>
</figure>

## `tree`

A disclosure tree: one row per item, 14px of indent per level, a vertical guide under each open parent, and a
chevron that turns when its item opens or closes. Children fold with a short height and opacity transition. Items
without children show no chevron (it keeps its space so labels align).

**Opening and closing.** `open` sets whether an item's children show (default closed). A click on a chevron opens or
closes that item at once, without a round trip, and Tern remembers it by item id until your view sends a
*different* `open` for that item: re-sending the same `open` keeps the user's choice; changing it overrides the
choice. An item whose id disappears forgets its local state. Only the chevron toggles: a click on the label does
nothing of its own.

**Long trees.** In the transcript a tree mounts only the visible rows (in preorder, flattened, class `.windowed`)
plus a few beyond each edge, between `.sf-data-pad` spacers; open/closed state is kept for unmounted items. Full
capture draws the nested form.

**Build it:** `tern.ui.tree(nodes)` (see [UI Builders](../reference/ui.md#tree)), or
`tern.ui.node("tree", { nodes = … })`. The builder assigns ids `t0`, `t1`, … depth-first; those shift when items are
added above, which moves the remembered state to other items. Build the props yourself with stable ids (a path, a
key) when the tree changes while the user is browsing it.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `nodes` | `{ TreeNode }` | `{}` | The top-level items |

`TreeNode` fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | string | required | Item identity, unique in the tree. An item without an id, or with an id already used, is skipped with its children |
| `label` | Spans | empty | The row's text; cut with an ellipsis |
| `icon` | string | none | An [icon name](#icon-names) shown before the label; an unknown name leaves an empty 14px slot |
| `open` | boolean | `false` | Whether the children show (see above) |
| `children` | `{ TreeNode }` | none | Nested items; an item is a parent only when it has at least one valid child |

**Children:** none (ignored); nesting lives in `nodes`.

**Events:** a chevron click sends `toggle` to your block's `event` handler:

```lua
{ ev = "toggle", id = "<tree node id>", key = "<item id>", collapsed = true }  -- collapsed = not open
```

To keep a choice across your own re-renders, store it from this event and send it back as `open`. `actions` work as on
any node.

**Styling:**

```html
<div class="sf sf-tree" role="tree" data-id="…">          <!-- .windowed when flattened -->
	<div class="sf-tree-node" role="treeitem" aria-level="1" aria-expanded="true" style="--d: 0">
		<div class="sf-tree-row">
			<button class="sf-tree-tw" data-key="src" title="Collapse" aria-label="Collapse"><svg class="ico">…</svg></button>
			<span class="sf-tree-ic" aria-hidden="true"><svg class="ico">…</svg></span>
			<div class="sf-tree-lbl">src</div>
		</div>
		<div class="sf-tree-kids" role="group">
			<div>
				<div class="sf-tree-node" role="treeitem" aria-level="2" style="--d: 1">
					<div class="sf-tree-row leaf">…</div>
					<div class="sf-tree-kids sf-hidden" role="group"><div></div></div>
				</div>
			</div>
		</div>
	</div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-tree` |
| Flattened (windowed) mode | `.sf-tree.windowed` |
| One item | `.sf-tree-node` (inner, may change); depth in `--d` (0 at the top) |
| A closed item | `.sf-tree-node.shut` (inner) |
| Row | `.sf-tree-row` (inner); `.sf-tree-row.leaf` without children |
| Chevron | `.sf-tree-tw` (inner); `[data-key]` is the item id |
| Icon | `.sf-tree-ic` (inner; `.sf-hidden` without `icon`) |
| Label | `.sf-tree-lbl` (inner) |
| Children group | `.sf-tree-kids > div` (inner; its `::before` draws the guide) |

Rows are `var(--sf-lh) + 6px` tall with a 5px radius and a `var(--l1)` hover; the chevron is `--t4`, the icon `--t3`,
guides `--l2`. In windowed mode guides are a repeating gradient on `.sf-tree-row::before`. The fold, the chevron
turn and the row hover transitions stop under Tern's reduced-motion setting (`.sf-still`) and
`prefers-reduced-motion`.

```lua
local ui = tern.ui

return ui.node("tree", {
	nodes = {
		{ id = "src", label = "src", icon = "folder", open = state.open["src"] ~= false, children = {
			{ id = "src/main.rs", label = "main.rs", icon = "file-code" },
			{ id = "src/lib.rs", label = ui.span("lib.rs", "muted"), icon = "file-code" },
			{ id = "src/kinds", label = "kinds", icon = "folder", open = state.open["src/kinds"], children = {
				{ id = "src/kinds/data.rs", label = "data.rs", icon = "file-code" },
			} },
		} },
		{ id = "Cargo.toml", label = "Cargo.toml", icon = "file" },
	},
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-data-tree.light.png" srcset="../figures/elements-data-tree.light.png 2x" alt="A tree: an open src folder with a guide line under it holding main.rs, a muted lib.rs and a closed kinds folder, then Cargo.toml at the top level">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-data-tree.dark.png" srcset="../figures/elements-data-tree.dark.png 2x" alt="A tree: an open src folder with a guide line under it holding main.rs, a muted lib.rs and a closed kinds folder, then Cargo.toml at the top level">
<figcaption>The tree above, with <code>src/kinds</code> (one child, no <code>open</code>) shown closed.</figcaption>
</figure>

```lua
-- in the block definition
event = function(state, ev, cx)
	if ev.ev == "toggle" then
		state.open[ev.key] = not ev.collapsed
	end
end,
```

## `badge`

A small rounded pill with plain text, tinted by its tone: text in the tone color, a 10% tone background and a 22%
tone ring. Without a tone (or with `neutral`) it is a gray chip. It never wraps or shrinks.

**Build it:** `tern.ui.badge(text, tone)` (see [UI Builders](../reference/ui.md#badge)), or
`tern.ui.node("badge", { text = …, tone = … })`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `text` | string | `""` | The label. Plain text only: spans are not read |
| `tone` | tone | none | Common prop: `neutral`, `accent`, `info`, `success`, `warning`, `error`, `pending`, `muted` or `user`; other values are ignored |

**Children:** none (ignored).

**Events:** none of its own; `actions` work as on any node.

**Styling:**

```html
<span class="sf sf-badge" data-id="…" data-tone="success">ok</span>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-badge` |
| A tone | `.sf-badge[data-tone='error']` |
| No tone | `.sf-badge:not([data-tone])` |

The badge is 18px tall, `padding: 0 7px`, `500 11px` sans, colored from `--tc` (the tone color the `[data-tone]`
rules set; see [Variables](../styles/variables.md)). The neutral look uses `--t2`, `--chip-bg` and `--l2`.

```lua
local ui = tern.ui

return ui.row({ ui.text("deploy"), ui.badge(ok and "passed" or "failed", ok and "success" or "error") })
```

Every tone, after a badge with none:

```lua
local tones = { "neutral", "accent", "info", "success", "warning", "error", "pending", "muted", "user" }
local badges = { ui.node("badge", { text = "untoned" }) }
for _, tone in tones do
	table.insert(badges, ui.badge(tone, tone))
end
return ui.node("row", { gap = "sm", wrap = true }, badges)
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-data-badges.light.png" srcset="../figures/elements-data-badges.light.png 2x" alt="Ten badges: untoned and neutral in gray, then accent, info, success, warning, error, pending, muted and user each tinted in its tone color">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-data-badges.dark.png" srcset="../figures/elements-data-badges.dark.png 2x" alt="Ten badges: untoned and neutral in gray, then accent, info, success, warning, error, pending, muted and user each tinted in its tone color">
</figure>

## `kbd`

A key combination as keycaps, one `.kbd` per key, 3px apart. Modifier and named keys take macOS glyphs; single
letters and function keys are upper-cased; anything else shows as written. Screen readers hear the spoken names
(`Control O`).

| Key name (any case) | Keycap | Spoken |
| --- | --- | --- |
| `ctrl`, `control` | `⌃` | Control |
| `alt`, `option`, `opt` | `⌥` | Option |
| `shift` | `⇧` | Shift |
| `cmd`, `command`, `meta`, `super`, `win` | `⌘` | Command |
| `enter`, `return` | `⏎` | Return |
| `esc`, `escape` | `esc` | Escape |
| `tab` | `⇥` | |
| `backspace` | `⌫` | |
| `delete`, `del` | `⌦` | |
| `space` | `␣` | |
| `up`, `down`, `left`, `right` | `↑` `↓` `←` `→` | |
| `pageup`, `pagedown` | `⇞` `⇟` | |
| `home`, `end` | `↖` `↘` | |
| one character (`o`, `/`) | upper-cased (`O`, `/`) | |
| `f1`…`f24` (`f` + digits) | `F1`…`F24` | |
| anything else (`fn`, `⌘`) | as written | |

Rows without a spoken name are read as their keycap. The glyphs are the same on every platform.

**Build it:** `tern.ui.node("kbd", { keys = { "ctrl", "o" } })`. There is no dedicated builder.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `keys` | `{ string }` | `{}` | Key names, in order; non-string entries are skipped |
| `aria` | string | none | Common prop: the `aria-label`. When set, Tern sets neither `role="img"` nor the spoken label |

**Children:** none (ignored).

**Events:** none of its own; `actions` work as on any node. Keycaps are display only: the keys reach your block's
`key` handler whether or not a `kbd` shows them.

**Styling:**

```html
<span class="sf sf-kbd kbds" data-id="…" role="img" aria-label="Control O">
	<span class="kbd">⌃</span>
	<span class="kbd">O</span>
</span>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-kbd` |
| One keycap | `.sf-kbd .kbd` (Tern's shared keycap class; also used in list hints) |

A keycap is 18px tall and at least 18px wide, `500 10.5px` mono in `--t2` on `--l1` with a `--l2` ring.

```lua
local ui = tern.ui

return ui.row({ ui.node("kbd", { keys = { "cmd", "shift", "p" } }), ui.text(ui.span("command palette", "muted")) })
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-data-kbd.light.png" srcset="../figures/elements-data-kbd.light.png 2x" alt="Keycaps ⌘ ⇧ P beside muted text command palette; below, keycaps for ctrl o, alt enter, esc, tab, backspace, space, up, pagedown, f5 and fn /">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-data-kbd.dark.png" srcset="../figures/elements-data-kbd.dark.png 2x" alt="Keycaps ⌘ ⇧ P beside muted text command palette; below, keycaps for ctrl o, alt enter, esc, tab, backspace, space, up, pagedown, f5 and fn /">
<figcaption>The example, then <code>ctrl o</code>, <code>alt enter</code>, <code>esc</code>, <code>tab</code>, <code>backspace</code>, <code>space</code>, <code>up</code>, <code>pagedown</code>, <code>f5</code> and <code>fn /</code>.</figcaption>
</figure>

## `icon`

One icon from Tern's set: a 16×16 box holding a 14px icon in the current text color, or the tone color with a
`tone`. Most icons are stroked; `logo`, `app-omp` and `slash` are filled. An unknown name draws an empty box. Icons
are decorative: Tern sets `aria-hidden="true"` unless you pass `aria`.

**Build it:** `tern.ui.node("icon", { name = "folder" })`. There is no dedicated builder. The same names work in a
`tree` item's `icon`, a list `item`'s `icon` and other kinds' `icon` props.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | none | An icon name or alias (below), case-sensitive. Anything up to the last `.` is dropped, so `icon.folder` and `status.error` work |
| `tone` | tone | none | Common prop; colors the icon |
| `aria` | string | none | Common prop: the `aria-label`. When set, Tern does not hide the icon from screen readers |

**Children:** none (ignored).

**Events:** none of its own; `actions` work as on any node (an icon with a `click` action is a compact button).

**Styling:**

```html
<span class="sf sf-icon" data-id="…" aria-hidden="true">
	<svg class="ico" aria-hidden="true">…</svg>
</span>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-icon` |
| Toned | `.sf-icon[data-tone]` (colored `var(--tc)`) |
| The glyph | `.sf-icon .ico` |

Icons stroke with `currentColor`, so `color` recolors them; resize with `width`/`height` on both the node and `.ico`.

```lua
local ui = tern.ui

return ui.row({ ui.node("icon", { name = "branch", tone = "accent" }), ui.text("main") })
```

### Icon names

Tern ships these 207 icons:

| Group | Names |
| --- | --- |
| Apps and brands | `app-btop`, `app-bun`, `app-claude`, `app-codex`, `app-deno`, `app-docker`, `app-go`, `app-hammer`, `app-helix`, `app-hermes`, `app-htop`, `app-java`, `app-node`, `app-omp`, `app-python`, `app-ruby`, `app-rust`, `app-vim`, `logo`, `tern`, `pi-mark` |
| Arrows and navigation | `arrow-up`, `arrow-down`, `arrow-left`, `arrow-right`, `back`, `forward`, `chev`, `chev-r`, `chev-up`, `corner-down-right`, `expand`, `shrink`, `minimize`, `fit`, `zoom-in`, `zoom-out`, `more`, `grip`, `compass` |
| Status and alerts | `check`, `x`, `x-circle`, `warn`, `info`, `help`, `bell`, `shield`, `shield-alert`, `slash`, `slash-circle`, `lock`, `key`, `key-round`, `plus`, `minus`, `clock`, `timer` |
| Files and documents | `doc`, `file`, `file-code`, `file-image`, `file-pdf`, `file-plus`, `files`, `folder`, `folder-go`, `folder-minus`, `folder-open`, `folder-plus`, `markdown`, `note`, `clipboard`, `save`, `inbox`, `image`, `newspaper`, `trash` |
| Version control | `branch`, `commit`, `merge`, `rebase`, `pull`, `push`, `fetch`, `stash`, `cherry`, `diff`, `unified`, `split`, `split-down`, `revert`, `history` |
| Playback and actions | `play`, `pause`, `stop`, `rewind`, `fast-forward`, `frame-next`, `frame-prev`, `repeat`, `redo`, `undo`, `run`, `reel`, `mic`, `wave`, `vibrate`, `power`, `send`, `share`, `open`, `download`, `copy`, `scissors` |
| Text and editing | `bold`, `italic`, `underline`, `type`, `align-left`, `align-center`, `align-right`, `align-justify`, `pen`, `eraser`, `wand`, `cursor`, `selection`, `path-insert`, `prompt`, `vector`, `blur`, `ink`, `palette` |
| Layout and windows | `columns`, `grid`, `sidebar`, `tabs-h`, `tabs-v`, `dock-up`, `dock-down`, `dock-left`, `dock-right`, `pip`, `pip-tl`, `pip-tr`, `pip-bl`, `pip-exit`, `layers`, `stack`, `kanban`, `canvas`, `diagram`, `flow`, `peek`, `tree`, `box`, `eye`, `eye-off` |
| Development and system | `terminal`, `code`, `braces`, `binary`, `bug`, `cpu`, `database`, `server`, `laptop`, `monitor`, `gauge`, `activity`, `chart`, `plug`, `puzzle`, `wrench`, `gear`, `sliders`, `stethoscope`, `hash`, `tag`, `link`, `globe`, `broadcast`, `search`, `funnel`, `funnel-x`, `sort-x`, `swap`, `list`, `list-checks`, `pin`, `keyboard` |
| People and misc | `user`, `users`, `message`, `brain`, `sparkle`, `lightbulb`, `bolt`, `flame`, `rocket`, `moon`, `sun`, `cart`, `footprints`, `scale`, `log-in`, `log-out` |

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-data-icons.light.png" srcset="../figures/elements-data-icons.light.png 2x" alt="All 207 icons in a four-column grid, each labeled with its name, in alphabetical order">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-data-icons.dark.png" srcset="../figures/elements-data-icons.dark.png 2x" alt="All 207 icons in a four-column grid, each labeled with its name, in alphabetical order">
<figcaption>Every icon, as <code>icon</code> nodes in the current text color.</figcaption>
</figure>

Aliases (omp's symbol names and common words) resolve to an icon when no icon has that name; an icon name always
wins over an alias:

`success` → `check`, `done` → `check`, `error` → `x`, `failed` → `x`, `warning` → `warn`, `pending` → `clock`,
`running` → `activity`, `aborted` → `stop`, `cancelled` → `stop`, `disabled` → `minus`, `model` → `sparkle`, `plan` →
`list`, `goal` → `pin`, `loop` → `redo`, `git` → `branch`, `pr` → `merge`, `tokens` → `hash`, `speculation` →
`selection`, `compaction` → `wand`, `context` → `layers`, `cost` → `hash`, `time` → `clock`, `omp` → `app-omp`, `hermes` → `app-hermes`,
`agents` → `user`, `agent` → `user`, `job` → `run`, `cache` → `database`, `input` → `download`, `output` → `send`,
`host` → `laptop`, `session` → `history`, `worktree` → `tree`, `bash` → `terminal`, `shell` → `terminal`, `python` →
`app-python`, `edit` → `pen`, `write` → `pen`, `read` → `doc`, `web` → `globe`, `url` → `link`, `todo` → `list`,
`task` → `layers`, `thinking` → `sparkle`, `settings` → `sliders`, `appearance` → `ink`, `interaction` → `keyboard`,
`memory` → `brain`, `tools` → `wand`, `tasks` → `list`, `providers` → `server`, `plugins` → `box`, `advisor` →
`sparkle`, `git-branch` → `branch`, `sparkles` → `sparkle`, `action` → `terminal`, `extension` → `puzzle`, `computer`
→ `monitor`, `stats` → `chart`, `news` → `newspaper`, `export` → `open`, `restart` → `revert`, `compress` → `shrink`,
`handoff` → `forward`, `question` → `help`, `pencil` → `pen`, `folderMove` → `folder-go`, `folderPlus` →
`folder-plus`, `folderMinus` → `folder-minus`, `hammer` → `app-hammer`, `prewalk` → `footprints`, `jobs` → `run`,
`signIn` → `log-in`, `signOut` → `log-out`, `package` → `box`, `fast` → `bolt`, `voice` → `mic`, `rule` → `scale`,
`skill` → `lightbulb`, `mcp` → `plug`, `path` → `folder`, `token_total` → `hash`, `time_spent` → `clock`.

## `image`

An image from a blob you send, or one Tern ships. A raster blob (PNG, JPEG, GIF, WebP, at most 4096 px a side) is
decoded off the main thread and painted with a 6px radius and a faint `--l1` ring. An SVG blob (`image/svg+xml`, at
most 256 KiB) is mounted as real SVG elements, so your sheets can style and animate it.

**Sizing.** `w`/`h` give the natural size in px (and so the aspect ratio); one of them alone is completed from the
decoded ratio; neither uses the decoded size. Raster and SVG previews shrink both axes together to fit the
available width and height bounds. `max.h` bounds the height (`"10lines"` or `"40ch"`; a fraction is ignored);
`max.w` bounds the width through the common props.

**Fit and scaling.** Raster pixels are placed in that box by `object-fit`, always centered: `contain` (the default,
so a declared size or CSS dimensions that differ from the source ratio never stretch the image), `cover` (fill the
box, cropping the overflow), `fill` (stretch to the box), `none` (the decoded size, one image pixel per CSS px,
cropped to the box) or `scale-down` (`none`, or `contain` when that is smaller). `image-rendering: pixelated` (or
`crisp-edges`) scales with the nearest pixel, keeping pixel art's hard edges; `auto`, `smooth` and `high-quality`
filter smoothly. Set both on the node, e.g. `.sf-image[data-role='sprite'] { object-fit: cover; image-rendering:
pixelated }`; `object-position` is not supported.

**Animation.** An animated GIF, APNG or animated WebP plays on its own: each frame for its delay (delays of 10 ms or
less play at 100 ms, as browsers do), as many times as the file's loop count says (forever when it says so), then
holds its last frame. It starts when the image first draws and runs on the window's animation clock, so it pauses
with the clock and skips ahead to the right frame after being scrolled out of view, where it costs no frames. An
animation over 1024 frames or 64 MiB of decoded pixels shows its first frame, still.

**Children.** An image's children are drawn over it, in a layer (`.sf-img-over`) covering the node's box: the
picture's height and the node's width. The layer is a column like `col`, so a sprite over a background is an `image`
inside an `image`, placed with a `row`/`col` or your own CSS; no absolute positioning is needed. Only the children take
the pointer: a click on the picture around them still zooms it, a click on a child does not.

```lua
-- an animated sprite standing at the bottom right of a background, its pixels scaled hard-edged
ui.node("image", { blob = state.meadow, alt = "Meadow", role = "meadow" }, {
	ui.node("col", { grow = 1 }),
	ui.node("row", { justify = "end" }, {
		ui.node("image", { blob = state.pikachu, alt = "Pikachu", role = "sprite", w = 96, h = 96 }),
	}),
})
-- your sheet: .sf-image[data-role='sprite'] { image-rendering: pixelated }
```

**While missing.** Until the blob arrives, while it decodes, or when it is not an image Tern can decode, the node
shows a dashed placeholder card with an image icon and `alt` (or "Image loading" / "Image unavailable"), with a
tooltip saying why: "The image data has not arrived", "The image is loading" or "Not an image format Tern can show"
(also an SVG over 256 KiB or without a size). A blob that arrives after the image drew shows on the node's next
change, so send the blob before (or with) the view that uses it.

**Zoom.** A click on a drawn blob image opens it in Tern's image viewer, with a zoom-in cursor on hover. When the
image's parent holds other blob images (a message's attachments), the viewer steps through all of them, starting at
this one. The viewer title is `alt` (else `title`). A node with its own `click` action runs that instead. `builtin`
images never zoom.

**SVG sanitizing.** An SVG keeps only `svg`, `g`, `defs`, `linearGradient`, `stop`, `path`, `circle`, `line`, `rect`,
`mask` and `text` elements, and only geometry and presentation attributes (`id`, `class`, `viewBox`, `d`, `x`/`y`,
`cx`/`cy`/`r`, `fill*`, `stroke*`, `opacity`, `transform`, `mask`, gradient and text attributes, …). `script`,
`foreignObject`, `image`, `use`, `title`, `style` attributes, event handlers and `href` are dropped. A `url(…)` value
survives only as a local `url(#id)`. Every `id` is prefixed per node so two copies never clash; `class` values are
kept, so `.sf-image .my-class` selectors work. The root needs a `viewBox` (or `width` and `height`).

**Canvas.** `tern.canvas` rejects `image` nodes (`canvas kind "image" is not supported`): use images in block and lens
views only.

**Build it:** send the bytes with `cx:blob(bytes, mime)` from a block handler (see
[Host API](../reference/api-host.md)), keep the returned id in state, and render
`tern.ui.node("image", { blob = id, alt = … })`. There is no dedicated builder.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `blob` | string | none | A blob id (the SHA-256 that `cx:blob` returns) |
| `builtin` | string | none | An image Tern ships, drawn instead of `blob`. The only one is `"omp"` (omp's animated gradient mark) |
| `alt` | string | `"Image"` for screen readers | Accessible name, placeholder text and viewer title |
| `w`, `h` | number | decoded size | Natural width and height in px; zero or negative is ignored |
| `max` | `{ w?, h? }` | none | Common prop; `h` bounds the image height in `"Nlines"` or `"Nch"` |
| `title` | string | none | Common prop: the tooltip. The zoom viewer also uses it as the name when there is no `alt` |
| `href`, `path` | string | none | Read by the zoom viewer, which may offer to open that file or page (`href` first) |

**Children:** any nodes, drawn over the picture (see **Children** above).

**Events:** none of its own. A click on a zoomable image runs the `zoom` action (it shows the viewer; your block
receives nothing). Your own `actions` work as on any node and take precedence for `click`.

**Styling:**

```html
<!-- raster -->
<div class="sf sf-image sf-zoom" data-id="…">
	<img class="sf-img-frame" alt="Build graph">
	<div class="sf-img-over">…children…</div>
</div>
<!-- SVG -->
<div class="sf sf-image sf-zoom" data-id="…">
	<svg class="sf-img-svg" role="img" aria-label="Build graph" viewBox="…">…</svg>
	<div class="sf-img-over">…children…</div>
</div>
<!-- missing or loading -->
<div class="sf sf-image missing" data-id="…">
	<div class="sf-img-card" role="img" aria-busy="true" title="The image is loading" aria-label="Build graph (image loading)">
		<span class="sf-img-ic"><svg class="ico">…</svg></span>
		<span class="sf-img-alt">Build graph</span>
	</div>
	<div class="sf-img-over">…children…</div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-image` |
| Zoomable | `.sf-image.sf-zoom` |
| Not drawn (absent, loading, undecodable) | `.sf-image.missing` |
| Raster frame | `.sf-img-frame` (inner, may change) |
| Inline SVG | `.sf-img-svg` (inner) and your own classes inside it |
| The children's layer | `.sf-img-over` (inner, may change) |
| Placeholder | `.sf-img-card`, `.sf-img-ic`, `.sf-img-alt` (inner, may change); `[aria-busy='true']` while loading |

The frame's ring brightens to `--l3` on hover and dims to 85% opacity while pressed. The placeholder card is
`2 × --sf-lh` tall with a dashed `--l3` border on `--sf-shade`.

```lua
local ui = tern.ui

tern.block.define("graph", {
	init = function(cx, args, saved)
		return { chart = cx:blob(tern.fs.read("graph.png"), "image/png") }
	end,
	view = function(state, cx)
		return {
			main = ui.col({
				ui.text(ui.span("Build graph", "strong")),
				ui.node("image", { blob = state.chart, alt = "Build graph", w = 480, h = 240, max = { h = "10lines" } }),
				-- state.coverage: a blob id whose bytes were not sent yet
				ui.node("image", { blob = state.coverage, alt = "Coverage chart" }),
			}),
		}
	end,
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-data-image.light.png" srcset="../figures/elements-data-image.light.png 2x" alt="A bar chart PNG with rounded corners and a faint ring, its height capped at ten lines, above a dashed placeholder card with an image icon reading Coverage chart">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-data-image.dark.png" srcset="../figures/elements-data-image.dark.png 2x" alt="A bar chart PNG with rounded corners and a faint ring, its height capped at ten lines, above a dashed placeholder card with an image icon reading Coverage chart">
<figcaption>A 480×240 PNG under <code>max.h = "10lines"</code> keeps its ratio as it shrinks; <code>state.coverage</code> names a blob that never arrived, so its node shows the placeholder.</figcaption>
</figure>

## Related pages

- [Elements](index.md): common props, actions and the kind index
- [Motion](motion.md): the `meter` kind behind meter cells
- [Lists](lists.md): selectable rows
- [UI Builders](../reference/ui.md): exact builder output
- [Styling views](../styles/index.md), [Variables](../styles/variables.md), [Supported CSS](../styles/css.md)
