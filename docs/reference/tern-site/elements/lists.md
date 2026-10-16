# Lists, Tabs and Pickers

Rows the user points at and your code selects. Use `list` with `item`
children for a selectable column of rows, `tabs` for a strip of tabs that
switches what you show, and `picker` when you want a full modal sheet
(search, scopes, fact columns, preview, action bar) drawn from data.

| Kind | Builder | Draws |
| --- | --- | --- |
| [`list`](#list) | `tern.ui.list(items)` or `tern.ui.node("list", …)` | A listbox of `item` rows with your selection, filter highlights and an empty line |
| [`item`](#item) | inside `tern.ui.list`, or `tern.ui.node("item", …)` | One row: icon, label, detail, value, key hint |
| [`tabs`](#tabs) | `tern.ui.node("tabs", …)` | A tab strip with an underlined active tab |
| [`picker`](#picker) | `tern.ui.node("picker", …)` | A modal glass sheet: search head, scopes, tabs, virtual rows, preview, action bar |

All four leave the selection to your code. A click or double-click sends an
event; you update your state and send the new `selected` (or `active`, or
`tab`) back in the next view. Keys never become events here: they reach your
block's `key` handler, which moves the selection the same way.

## `list`

A vertical listbox of `item` children. It draws:

- the selected item (your `selected` prop) with an accent tint and a 2px
  leading bar, and a hover tint on the others;
- `<mark>` highlights of the `filter` query in each item's label;
- the `empty` line when it has no items.

The list does not filter, sort or move the selection itself. `filter` only
marks: pass the items you want shown, already filtered, and the query that
produced them.

**Filter marking.** The query is trimmed and matched case-insensitively
against the label's plain text. The first contiguous occurrence of the whole
query is marked; when there is none, the kit's fuzzy subsequence match marks
its hit characters, adjacent hits merged into runs. No match marks nothing.
Span styles in the label are kept across the cut. For example, `LIFE` marks
`Life` in `Session Lifecycle`; `sl` marks the `s` and the `l` of
`session-lifecycle`.

**Height and scrolling.** Without `max` the list is as tall as its rows and
scrolls with the region around it. With `max` it caps its own height and
scrolls inside itself (`.sf-list-scroll.max`, thin scrollbar, overscroll
contained). Each row is one line of the terminal font plus 6px.

**Keeping the selection in view.** When `selected` changes, the list scrolls
its own scroller (only when `max` is set) to show that item, the least
distance needed. A protocol `reveal` request for an item of the list scrolls
the list's own scroller the same way, aligned to start, end or nearest; a
list without `max` leaves the scrolling to the region. Plugins have no call
that sends `reveal`; changing `selected` is how a plugin brings an item into
view. A selected item inside a list that scrolls with `main` is not scrolled
to by the list.

**Virtual lists.** Past 200 items, or with `virtual = true`, the items are
not mounted as nodes. Rows get a fixed height and a pool of absolutely
positioned rows (`.sf-item.sf-vrow`) is refilled from the scroll offset, six
rows of overscan each way. An item's content is read only when its row
enters the window. Clicks still send `select` and `activate` with the item's
node id. In a virtual list, an item's own `actions` and its links are not
wired: the row only selects and activates.

**Build it:** `tern.ui.list(items)` builds a `list` of `item` children from
`{label, detail?, value?, icon?, tone?}` tables (see
[UI Builders](../reference/ui.md#list)). Set `selected`, `filter`, `empty`,
`max` or `virtual` on the returned node's `p`, or use
`tern.ui.node("list", { … }, items)`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `selected` | `string` | none | Node id of the selected item. Drawn as selected (`.sel`, `aria-selected="true"`) and kept in view when it changes. An id that is not a child draws nothing selected |
| `filter` | `string` | `""` | Query whose matches are marked in each item's label with `mark.sf-mark`. Marking only; it hides nothing |
| `empty` | Spans | none | Line shown when the list has no children. Nothing shows when unset |
| `max` | `{lines = n}` or `number` | none | Height cap. `{lines = n}`: `n` rows. A number: that fraction of the window height (`0.5` = `50vh`). Non-positive or other values are ignored. With a cap the list scrolls itself |
| `virtual` | `boolean` | `false` | Virtualize the rows even under 200 items |

The [common props](index.md) apply too (`key`, `role`, `tone`, `actions`).

**Children:** `item` nodes, drawn in order inside `.sf-list-slot`. Other
kinds are placed as well but get no row behavior. In a virtual list the
children are not mounted: each child's item props are read into a pooled
row.

**Events:** none of its own. Its items send `select` and `activate` naming
the list (see [`item`](#item)).

**Styling:**

```html
<div class="sf sf-list" data-id="main.items" role="listbox">
	<div class="sf-list-scroll max">            <!-- .max only with `max` -->
		<div class="sf-list-slot">
			<div class="sf sf-item sel" data-id="main.items.i1" role="option" aria-selected="true">…</div>
		</div>
		<div class="sf-list-spacer sf-hidden">  <!-- virtual: shown, holds the pool -->
			<div class="sf sf-item sf-vrow" role="option" data-item="main.items.i1">…</div>
		</div>
	</div>
	<div class="sf-list-empty sf-hidden">No results</div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-list`, `.sf-list[data-id=…]`, `.sf-list[data-role=…]` |
| A virtual list | `.sf-list.virtual` |
| Its scroller | `.sf-list-scroll` (inner, may change); `.sf-list-scroll.max` when capped |
| Mounted items | `.sf-list-slot` (inner, may change) |
| Virtual rows | `.sf-list-spacer`, `.sf-item.sf-vrow[data-item=…]` (inner, may change) |
| The empty line | `.sf-list-empty` (inner, may change) |
| Selected item | `.sf-list .sf-item.sel`, `[aria-selected='true']` |
| Filter hits | `.sf-list mark.sf-mark` |

`.sf-hidden` hides parts that have nothing to show (the empty line while
there are items, the scroller while there are none). The selection tint is
`var(--sf-sel)` when you set it, else the accent at 10% (light) or 16%
(dark); the bar is `inset 2px 0 0 var(--accent)`. Hover uses `--l1`. Inside an
`overlay` card (`.sf-ov-card`) the selection is a neutral `--l2` fill with a
`--grad` edge instead. Rows use `--sf-lh` for their height. See
[Variables](../styles/variables.md).

Stable hooks are `.sf-list`, `.sf-item`, `[data-id]`, `[data-role]`,
`[data-tone]` and the ARIA attributes; the `sf-list-*` and `sf-item-*` parts are
Tern's structure.

```lua
local ui = tern.ui

-- view: state.visible holds the branches matching state.query ("log"),
-- state.sel the selected branch name ("fix-login")
local rows = {}
for _, b in state.visible do
	local row = ui.list({ {
		label = b.name,
		detail = b.upstream or "no upstream",
		value = b.drift, -- "↑2", "↓5" or nil
		icon = "git-branch",
		tone = b.behind and "warning" or nil,
	} }).c[1]
	row.p.key = b.name
	row.p.disabled = b.upstream == nil
	table.insert(rows, row)
end
return {
	main = ui.col({
		ui.node("list", {
			key = "branches",
			selected = state.sel and ("main.branches." .. state.sel) or nil,
			filter = state.query,
			empty = { ui.span("No branches match", "muted") },
			max = { lines = 12 },
		}, rows),
	}),
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-lists-list.light.png" srcset="../figures/elements-lists-list.light.png 2x" alt="A list of four branch rows filtered by log: the selected fix-login row has an accent tint and a leading bar, each label marks log, a warning row has an amber icon and the branch without upstream is dimmed">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-lists-list.dark.png" srcset="../figures/elements-lists-list.dark.png 2x" alt="A list of four branch rows filtered by log: the selected fix-login row has an accent tint and a leading bar, each label marks log, a warning row has an amber icon and the branch without upstream is dimmed">
<figcaption>Selection, <code>filter</code> marks, a <code>warning</code> tone and a disabled row.</figcaption>
</figure>

## `item`

One row: an icon, the label, a dim detail that takes the free room and
truncates, a right-aligned value, and keycaps. Inside a `list` it is an
`option` of the listbox; on its own it is a plain row with the same parts.
Text never wraps; label, detail and value truncate with an ellipsis.

**Build it:** as an element of `tern.ui.list(items)` (see
[UI Builders](../reference/ui.md#list)), which covers `label`, `detail`,
`value`, `icon` and `tone`. `hint` and `disabled` need
`tern.ui.node("item", { … })` or setting them on the built child's `p`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `label` | Spans | `""` | The row's text. Filter hits are marked in it |
| `detail` | Spans | `""` | Dim text after the label; flexes and truncates first |
| `value` | Spans | `""` | Right-aligned text (tabular numbers, at most 40% of the row). Hidden when empty |
| `icon` | `string` | none | An icon name (see [`icon`](data.md#icon)); unknown names show no icon |
| `hint` | `{ string }` | `{}` | Key names drawn as keycaps at the end, e.g. `{ "cmd", "enter" }`. Display only: it binds nothing |
| `disabled` | `boolean` | `false` | Dims the row (`.off`, `aria-disabled="true"`), takes no pointer events and sends no `select` or `activate` |
| `tone` | tone name | none | Sets `data-tone`; tints the icon. One of `neutral`, `accent`, `info`, `success`, `warning`, `error`, `pending`, `muted`, `user`; other names are ignored |

**Children:** none (ignored).

**Events:**

| Gesture | Event |
| --- | --- |
| Click | `{ev = "select", id = <list id>, item = <item id>}` |
| Double-click | `{ev = "activate", id = <list id>, item = <item id>}` |

A double-click also sends the `select` of its first click. Outside a list,
`id` and `item` are both the item's own id. A disabled item sends neither.
A click on a link span in the item opens the link (with ⌘) instead of
selecting. When the item has its own `actions.click`, that action replaces
`select`; its own `actions.dblclick` replaces `activate`. The events go to
your block's `event(state, ev, cx)`; nothing changes on screen until your
view sends the new `selected`.

Keys (arrows, Enter) are not handled by the list: they reach your block's
`key` handler. Move your selection there and return the new view.

**Styling:**

```html
<div class="sf sf-item sel" data-id="main.items.i1" data-tone="warning"
		role="option" aria-selected="true">
	<span class="sf-item-ic"><!-- icon --></span>
	<span class="sf-item-label">fix-<mark class="sf-mark">log</mark>in</span>
	<span class="sf-item-detail">origin/fix-login</span>
	<span class="sf-item-value">↑2</span>
	<span class="sf-item-hint kbds"><!-- keycaps (.kbd) --></span>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-item`, `.sf-item[data-id=…]` |
| Selected | `.sf-item.sel` |
| Disabled | `.sf-item.off`, `[aria-disabled='true']` |
| Toned | `.sf-item[data-tone='warning']` |
| Icon | `.sf-item-ic` (inner, may change) |
| Label | `.sf-item-label` (inner, may change) |
| Detail | `.sf-item-detail` (inner, may change) |
| Value | `.sf-item-value` (inner, may change) |
| Key hint | `.sf-item-hint`, `.sf-item-hint .kbd` (inner, may change) |
| Filter hits | `.sf-item mark.sf-mark` |

Empty icon, value and hint parts carry `.sf-hidden`. The icon takes `--tc`,
the tone color, when `data-tone` is set (`--t3` for `neutral`, `--accent-ink`
on a selected row without a tone). The detail and value are `--t3`, a
disabled row `--t4`. Under reduced motion (`.sf-still` or
`prefers-reduced-motion`) the hover and selection transitions are off.

```lua
local ui = tern.ui

ui.node("item", {
	key = "deploy",
	label = "Deploy",
	detail = "production",
	icon = "jobs",
	hint = { "cmd", "enter" },
	tone = "accent",
})
```

## `tabs`

A row of tabs over a hairline; the active one is underlined with the accent.
The strip does not scroll: tabs past its width are clipped. The active tab
is yours: a click sends `select`, and the strip changes only when you send
a new `active`.

**Build it:** `tern.ui.node("tabs", { items = { … }, active = "…" })`. No
dedicated builder.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `items` | `{ {id: string, label: Spans} }` | `{}` | The tabs in order. Entries without an `id` are skipped |
| `active` | `string` | none | `id` of the active tab (`.on`, `aria-selected="true"`) |

**Children:** none (ignored).

**Events:** a click on a tab sends `{ev = "select", id = <tabs node id>,
item = <tab id>}`. `item` is the tab's `id` from `items`, not a node id.

**Styling:**

```html
<div class="sf sf-tabs" data-id="main.tabs" role="tablist">
	<div class="sf-tab on" role="tab" aria-selected="true" data-tab="files">Files</div>
	<div class="sf-tab" role="tab" aria-selected="false" data-tab="commits">Commits</div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-tabs` |
| A tab | `.sf-tab`, `.sf-tab[data-tab='files']` |
| Active tab | `.sf-tab.on`, `.sf-tab[aria-selected='true']` |

The strip uses `--sans` at 12px; inactive tabs are `--t3`, hover adds `--l1`,
the active underline is `--accent`, the hairline `--l2`. Transitions are off
under reduced motion.

```lua
local ui = tern.ui

ui.node("tabs", {
	key = "tabs",
	active = state.tab,
	items = {
		{ id = "files", label = "Files" },
		{ id = "commits", label = { ui.span("Commits "), ui.span("12", "muted") } },
		{ id = "checks", label = "Checks" },
	},
})

-- event(state, ev, cx)
-- if ev.ev == "select" and ev.id == "main.tabs" then state.tab = ev.item end
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-lists-tabs.light.png" srcset="../figures/elements-lists-tabs.light.png 2x" alt="A tab strip with Files active, underlined in the accent, and Commits 12 and Checks dimmed over a hairline">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-lists-tabs.dark.png" srcset="../figures/elements-lists-tabs.dark.png 2x" alt="A tab strip with Files active, underlined in the accent, and Commits 12 and Checks dimmed over a hairline">
<figcaption>The strip with <code>active = "files"</code>.</figcaption>
</figure>

## `picker`

A data-first modal sheet: you send the catalog and what to show, and Tern
draws a glass sheet with a search head, optional scope column, tab row,
fact columns, virtualized rows, a preview pane and an action bar. It is
built for omp (the coding agent's model selector, session picker and
settings) and is styled by `omp-pickers.css`, which is loaded for every
surface, so it looks the same in a plugin block.

**From a plugin.** It works in a block, placed directly in the `layer`
region: the node *is* the sheet, positioned over the whole block
(`position: absolute; inset: 0`) above a dim, blurred backdrop. In `main` or
in a lens it covers its container instead and is rarely what you want. It
draws no real text field: the search line shows your `query` with a drawn
caret, so typing, arrows, Enter and Escape must be handled in your block's
`key` handler, which updates `query`, `selected` and the rest. Pointer input
arrives as events (below). It is a heavyweight component; for a plain
selectable list in your own layout use [`list`](#list).

### Layout and behavior

- **Sizes.** `size = "lg"` (default) is a sheet top-centered, up to
  1120×760px, 28px from the top. `"md"` is a palette-sized sheet up to
  680px wide and 540px tall, 72px from the top. `"screen"` fills the
  surface with no backdrop, radius or shadow.
- **Narrow sheets.** Under 760px wide the scope column folds into a head
  button (`.narrow`) whose menu sends the same `scope` action, and the
  subtitle hides. A side preview moves below the list under 980px
  (`.pv-below-auto`); under 640px the preview hides and so does the count
  (`.pv-hide`). An `md` sheet shows its subtitle only without a `query`:
  the head is then the title with the subtitle on a line under it.
- **Rows** are virtualized with fixed heights per layout: `rows` 36px,
  `cards` 54px, `timeline` 26px (34px for `node = "user"`), `tree` 24px; group
  headers 32px. One selection bar (`.pk-selbar`) slides between rows. The
  group of the first visible row sticks to the top (`.pk-sticky`). Match
  `hits` draw bold in the label, without the tint `list` uses.
- **Keeping the selection in view.** The list scrolls to the selection when
  it opens, when the layout changes, when `selected` changes, and when rows
  change while the selection was visible. A list the reader scrolled away
  from stays put through updates.
- **Fact columns** hide lowest `priority` first until the label keeps 260px.
  A `text` column grows to fit its widest value (up to 320px) out of the
  room the label leaves, narrowing back to its default before any column
  hides; a value still cut short shows whole as the fact's tooltip.
- **Head `esc`.** The head's `esc` keycap shows only when no action has
  `"esc"` or `"escape"` in its `keys`; that action's bar button stands in
  for it.
- **Action bar folding.** When the bar's buttons overflow, the action bound
  to Escape (unless it is `primary`) moves into the head's `esc` button
  (`.fold-esc`), then secondary buttons drop their keycaps (`.fold-keys`);
  it unfolds when the width is back.
- **Motion.** The sheet animates in, changed rows stagger in (up to 8 rows,
  24ms apart), bar facts grow from zero on first show. Under `.sf-still` or
  `prefers-reduced-motion` these are off.

**Build it:** `tern.ui.node("picker", props, preview_children)`. No dedicated
builder.

### Sheet props

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `size` | `"md"` \| `"lg"` \| `"screen"` | `"lg"` | Sheet size (above). Other values fall back to `"lg"` |
| `layout` | `"rows"` \| `"cards"` \| `"timeline"` \| `"tree"` | `"rows"` | Row template. `cards` puts `detail` on its own line; `timeline` draws a node per row; `tree` draws depth guides and a disclosure chevron |
| `preview` | `"side"` \| `"below"` \| `"none"` | `"side"`, `"none"` for `md` | Where the preview pane sits |
| `title` | Spans | none | Heading (not the common tooltip). Without it the head is the icon and the search only (`.no-title`); the sheet's accessible name is then `placeholder`, else `noun` |
| `subtitle` | Spans | none | Second part of the heading |
| `icon` | `string` | a list icon | Head icon name |
| `query` | `string` | none | The search text. Unset hides the search (`.no-query`); `""` shows the placeholder |
| `cursor` | `number` | end of `query` | Caret position in `query`, in UTF-16 units |
| `placeholder` | `string` | `"Search <noun>…"` | Search placeholder |
| `noun` | `string` | `"items"` | What the rows are, used in the placeholder and the empty texts |
| `focus` | `"list"` \| `"scopes"` \| `"tabs"` \| `"strip"` \| `"preview"` | `"list"` | Which part your keys drive; sets `.f-<focus>` on `.pk-sheet`. The caret shows only for `list`; the others ring the active scope, the active tab, the `selected` strip chip or the preview pane |
| `state` | `"ready"` \| `"loading"` \| `"error"` | `"ready"` | `loading` shows 8 skeleton rows and `…` as the count; `error` shows `message` in an alert card. Sets `.st-loading` / `.st-error` |
| `message` | Spans | none | Error card text for `state = "error"` |
| `empty` | Spans | `"No <noun> yet"` | Text when there are no rows and `query` is empty |
| `total` | `number` | none | Catalog size; the count reads `"<shown> of <total>"` when it differs |

### Rows: `items`, `order`, selection

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `items` | `{ PickerItem }` | `{}` | The catalog, by `id`. Replacing it rebuilds the rows |
| `itemsAdd` | `{ PickerItem }` | none | Items added to (or replacing in) the catalog by `id` |
| `itemsDel` | `{ string }` | none | Item ids removed from the catalog |
| `order` | `{ string \| {group, label, count?} }` | `items` order | What to show, in order: item ids (unknown ids are skipped) and group headers. A header is any table with a `group` field; it shows `label` and an optional `count` (thousands-separated) |
| `selected` | `string` | none | Selected item id: the selection bar, `aria-activedescendant` |
| `current` | `{ string }` | `{}` | Item ids marked current with a check (`.cur`); while any is current every row keeps the check slot (`.has-cur`) |
| `hits` | `{ [id]: { {from, to} } }` | none | Match ranges per item id: positional `{from, to}` pairs (JSON `[[0, 2]]`), UTF-16 `[from, to)` offsets in the label's plain text; overrides the item's own `hits` |
| `columns` | `{ Column }` | `{}` | Fact columns, at most 8 |
| `confirm` | `{text, act?, label?}` | none | A confirm strip over the selected row: a trash icon, `text`, a danger button `label` (default `"Delete"`) sending `act` (default `"confirm"`), and `Keep` sending `cancel` |

`PickerItem`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Required; items without one are dropped |
| `label` | Spans | Row text. With `mono = true` and a plain label containing `/`, it splits into a dim `dir` that truncates first and a `name` |
| `detail` | Spans | Inline after the label (its own line in `cards`) |
| `icon` | `string` | Lead icon name |
| `role` | `string` | Picks the lead icon from a role name when `icon` is unset |
| `mark` | `{text, seed?}` | An initials avatar (first two non-space chars of `text`) on a gradient from `seed` (default `text`); wins over `icon` |
| `dot` | tone name | A status dot as the lead when there is no mark or icon, else a corner dot (not in `tree`). Not drawn in `timeline`. In `tree`, `"accent"` lights the depth guides |
| `mono` | `boolean` | Monospace label |
| `facts` | `{ [column id]: number \| Spans }` | Column values. Numbers show compact (`272k`, `1.6M`); in a `bar` column a number 0–1 is a meter |
| `badges` | `{ {text, tone?, title?} }` | Up to 3 badges after the label, then a `+N` badge whose tooltip lists the rest |
| `chips` | `{ {text, on?, auto?, dot?} }` | Role chips after the badges; `dot` is a palette name drawn with `--sf-p-<dot>` |
| `tone` | tone name | `data-tone` on the row |
| `disabled` | `true` \| `string` | Dims the row (`.off`); a string is its tooltip reason. A disabled row still selects but never activates |
| `hits` | `{ {from, to} }` | Match ranges in the label: positional pairs (JSON `[[0, 2]]`), UTF-16 `[from, to)` offsets, marked with `mark.sf-mark` |
| `node` | `string` | `timeline`: node style `n-<node>` (`user`, `tool` with its icon, default `assistant`); also `data-node` |
| `depth` | `number` | `tree`: indent guides |
| `open` | `boolean` | `tree`: chevron, rotated when `true`; unset is a leaf |
| `title` | `string` | Row tooltip (also on a `bar` fact) |

`Column`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | `string` | required | The `facts` key |
| `head` | `string` | `""` | Head label. With any head, heads ride on the first group header and the sticky header, or on their own `.pk-colhead` row when the list does not start with a group |
| `format` | `"text"` \| `"num"` \| `"price"` \| `"bar"` \| `"time"` \| `"elapsed"` \| `"dim"` | `"text"` | Class `f-<format>` and default width: text 96 (growing to fit its values when there is room), num 52, price 76, bar 44, time 44, elapsed 52, dim 64 px. It styles the column but does not format values: outside `bar` a number shows compact (`3`, not `$3`), so send prices and times as text |
| `priority` | `number` | `100` | Lower hides first when the list is narrow |
| `min` | `number` | none | Minimum width in characters |

### Scopes, tabs, strip, actions

| Prop | Type | Meaning |
| --- | --- | --- |
| `scopes` | `{ {id, label, group?, mark?, icon?, dot?, count?, disabled?} }` | A vertical scope column at the left. Consecutive scopes with the same `group` share a header; a change to no group draws a separator. `disabled` (true or a reason) adds a lock and tooltip but still sends the action |
| `scope` | `string` | Active scope id |
| `tabs` | `{ {id, label, count?} }` | A tab row over the list: a segmented control up to 4 tabs, chips beyond |
| `tab` | `string` | Active tab id |
| `strip` | `{label?, items = { {id, label, on?, dot?} }, selected?}` | A row of switch chips above the action bar; `on` checks a chip, `selected` outlines one |
| `actions` | `{ {id, label?, keys?, primary?, end?, danger?, on?, disabled?} }` | The action bar; `label` defaults to `id`. Secondary actions sit left, `end` ones right, the `primary` one last in the corner. `keys` draws keycaps; an action with `"escape"`/`"esc"` in `keys` is what the backdrop and head `esc` send. `on` makes a pressed toggle. `disabled` (true or a reason) dims it (`.off`, reason as tooltip) and its clicks send nothing |

In the empty state with no query, the first action whose `keys` include
`"tab"` is offered as a button; in the error state, the action with
`id = "retry"`.

**Children:** the preview. Children are drawn in `.pk-pv-slot`; with none,
the pane says "Nothing to preview". `preview = "none"` hides the pane.

### Events

`id` is the picker node's id.

| Gesture | Event |
| --- | --- |
| Click a row | `{ev = "select", id, item}` |
| Click the selected row, click the row clicked last, or double-click a row | `{ev = "activate", id, item}` (once per double-click; never for a disabled row) |
| Click a scope, or pick one in the narrow scope menu | `{ev = "action", id, act = "scope", value = <scope id>}` |
| Click a tab | `{ev = "action", id, act = "tab", value = <tab id>}` |
| Click a strip chip | `{ev = "action", id, act = "strip", value = <chip id>}` |
| Click an action bar button | `{ev = "action", id, act = <action id>}` |
| Click the backdrop or the head `esc` | `{ev = "action", id, act = <escape action id or "close">}` |
| Confirm strip buttons | `act = <confirm.act or "confirm">`, or `act = "cancel"` |
| Empty state `Clear search` | `{ev = "action", id, act = "clear"}` |
| Empty or error state button | `{ev = "action", id, act = <that action's id>}` |

Group headers send nothing. Keys are yours: handle them in `key`.

### Styling

```html
<div class="sf sf-picker sz-lg lay-rows pv-side has-cur" data-id="layer.models">
	<div class="pk-dim" aria-hidden="true"></div>
	<div class="pk-sheet f-list" role="dialog" aria-modal="true">
		<div class="pk-head">
			<span class="pk-ic"></span>
			<div class="pk-title"><span class="t">Models</span><span class="sub">…</span></div>
			<button class="pk-scopebtn" data-pk="menu"></button>
			<div class="pk-search"><span class="q">son</span><span class="caret"></span></div>
			<span class="pk-count">12 of 140</span>
			<button class="pk-esc" data-pk="act" data-v="close"><span class="kbd">esc</span></button>
		</div>
		<div class="pk-body">
			<div class="pk-scopes" role="tablist">
				<div class="pk-sgh">Providers</div>
				<div class="pk-scope nav-row on" data-pk="scope" data-v="all">…</div>
			</div>
			<div class="pk-center">
				<div class="pk-main">
					<div class="pk-tabs seg"><div class="pk-tabs-in"><button class="pk-tab on" data-pk="tab" data-v="…"></button></div></div>
					<div class="pk-colhead"></div>
					<div class="pk-list">
						<div class="pk-sticky pk-row grp"></div>
						<div class="pk-scroll">
							<div class="pk-spacer" role="listbox">
								<div class="pk-selbar"></div>
								<div class="pk-confirm" role="alertdialog"></div>
								<div class="pk-row sel cur" role="option" data-pk="row" data-v="sonnet" id="pk-sonnet">
									<span class="pk-lead"></span>
									<div class="pk-txt"><div class="pk-l1">
										<span class="pk-label">…</span><span class="pk-tags">…</span>
										<span class="pk-detail"><span class="t">…</span></span>
									</div></div>
									<div class="pk-facts"><span class="pk-fact c0 f-price">$3</span></div>
									<span class="pk-cur"></span>
								</div>
							</div>
						</div>
					</div>
					<div class="pk-state"></div>
				</div>
				<div class="pk-pv"><span class="pk-pv-empty">Nothing to preview</span><div class="pk-pv-slot">…</div></div>
			</div>
		</div>
		<div class="pk-strip" role="toolbar"></div>
		<div class="pk-bar" role="toolbar"><button class="pk-btn" data-pk="act" data-v="…"></button><span class="pk-bar-fill"></span><button class="pk-btn primary">…</button></div>
	</div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-picker`, `.sf-picker[data-id=…]`, `[data-role=…]` |
| Size, layout, preview | `.sz-md` `.sz-lg` `.sz-screen`, `.lay-rows` `.lay-cards` `.lay-timeline` `.lay-tree`, `.pv-side` `.pv-below` `.pv-none` |
| Width states | `.narrow`, `.pv-below-auto`, `.pv-hide`, `.fold-esc`, `.fold-keys`, `.h0`–`.h7` (column hidden) |
| Content states | `.no-title`, `.no-query`, `.has-cur`, `.st-loading`, `.st-error` |
| Backdrop, sheet | `.pk-dim`, `.pk-sheet`, `.pk-sheet.f-<focus>` (inner, may change) |
| Head | `.pk-head`, `.pk-ic`, `.pk-title .t`, `.pk-title .sub`, `.pk-search .q/.ph/.caret`, `.pk-count`, `.pk-esc`, `.pk-scopebtn` (inner, may change) |
| Scopes | `.pk-scopes`, `.pk-scope`, `.pk-scope.on`, `.pk-scope.dis`, `.pk-sgh`, `.pk-ssep`, `.pk-lock` (inner, may change) |
| Tabs | `.pk-tabs.seg` / `.pk-tabs.chips`, `.pk-tab`, `.pk-tab.on`, `.pk-tab .n` (inner, may change) |
| Rows | `.pk-row`, `.pk-row.sel`, `.pk-row.cur`, `.pk-row.off`, `.pk-row.grp`, `.pk-row[data-v=…]`, `.pk-row[data-tone=…]`, `.pk-row[data-node=…]`, `.pk-row.arr-a/.arr-b` (arriving) (inner, may change) |
| Row parts | `.pk-lead`, `.pk-mark`, `.pk-dot`, `.pk-dot.corner`, `.pk-node.n-<node>`, `.pk-guides .pk-g`, `.pk-chev`, `.pk-label`, `.pk-label.mono.path .dir/.name`, `.pk-tags`, `.pk-badge`, `.pk-chip`, `.pk-detail`, `.pk-facts`, `.pk-fact.c<i>.f-<format>`, `.pk-meter`, `.pk-cur`, `.pk-gl`, `.pk-gc` (inner, may change) |
| Selection, sticky, confirm | `.pk-selbar`, `.pk-sticky`, `.pk-spacer.confirming`, `.pk-confirm`, `.pk-ct` (inner, may change) |
| States | `.pk-state.loading .pk-sk`, `.pk-state.error .pk-err`, `.pk-state.empty .pk-empty` (inner, may change) |
| Preview | `.pk-pv`, `.pk-pv-empty`, `.pk-pv-slot` (inner, may change) |
| Strip, bar | `.pk-strip`, `.pk-strip-l`, `.pk-schip`, `.pk-bar`, `.pk-btn`, `.pk-btn.primary/.danger/.on/.off/.esc` (inner, may change) |
| Filter hits | `.sf-picker mark.sf-mark` |

Every `pk-*` class is Tern's structure for omp's sheet; only `.sf-picker`
and its state classes on the root are worth relying on. The sheet uses the
theme's `--pop-bg`, `--glass-hi`, `--dim`, `--l1`–`--l3`, `--t1`–`--t4`,
`--accent` and `--grad`, and chip dots read `--sf-p-<name>` (see
[Variables](../styles/variables.md)).

```lua
local ui = tern.ui

-- in a block view; state.query ("cl") and state.sel ("sonnet") are driven
-- by your key handler, state.current ("opus") is the model in use
local items, order = {}, {}
for _, g in state.groups do -- the models matching state.query, by provider
	table.insert(order, { group = g.id, label = g.name, count = #g.models })
	for _, m in g.models do
		table.insert(items, {
			id = m.id,
			label = m.path, -- "anthropic/claude-opus": dim dir, bold hits
			mono = true,
			icon = "model",
			hits = { { m.hit, m.hit + #state.query } }, -- UTF-16 offsets
			facts = { ctx = m.context, price = m.price }, -- 200000, "$15"
			disabled = m.offline and (m.runtime .. " is not running") or nil,
		})
		table.insert(order, m.id)
	end
end
return {
	main = ui.col({ ui.text("Choose the model for this session.") }),
	layer = ui.col({
		ui.node("picker", {
			key = "models",
			size = "md",
			title = "Model",
			noun = "models",
			query = state.query,
			items = items,
			order = order,
			selected = state.sel,
			current = { state.current },
			columns = {
				{ id = "ctx", head = "Context", format = "num" },
				{ id = "price", head = "$/M", format = "price", priority = 50 },
			},
			actions = {
				{ id = "close", label = "Cancel", keys = { "esc" } },
				{ id = "use", label = "Use", keys = { "enter" }, primary = true },
			},
		}),
	}),
}

-- event(state, ev, cx)
-- ev.ev == "select"   -> state.sel = ev.item
-- ev.ev == "activate" -> use ev.item
-- ev.ev == "action" and ev.act == "close" -> hide the picker
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-lists-picker.light.png" srcset="../figures/elements-lists-picker.light.png 2x" alt="An md picker sheet over a dimmed, blurred block: head with the Model title and the query cl, an Anthropic group header carrying the Context and $/M column heads, three model rows with the sonnet row selected and opus checked as current, a Local group with a dimmed disabled row, and a Cancel esc and primary Use action bar">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-lists-picker.dark.png" srcset="../figures/elements-lists-picker.dark.png 2x" alt="An md picker sheet over a dimmed, blurred block: head with the Model title and the query cl, an Anthropic group header carrying the Context and $/M column heads, three model rows with the sonnet row selected and opus checked as current, a Local group with a dimmed disabled row, and a Cancel esc and primary Use action bar">
<figcaption>An <code>md</code> sheet in the <code>layer</code> region. At this width (under 640px) the count is hidden.</figcaption>
</figure>

## Related pages

- [Building Views](../guides/views.md): actions and events.
- [Blocks](../guides/blocks.md): node ids, keys, the `key` handler.
- [Styling views](../styles/index.md), [Variables](../styles/variables.md).
