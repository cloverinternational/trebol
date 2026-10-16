# Layout

Layout kinds arrange other nodes. Use `col` and `row` to stack nodes and lay them side by side, `card` to frame a
unit of work with a head, a status and an optional fold, `section` for a lighter fold with no frame, `rule` for a
divider and `spacer` for fixed vertical space.

| Kind | Builder | Draws |
| --- | --- | --- |
| [`col`](#col) | `tern.ui.col(…)`, `tern.ui.lines(…)` | A vertical flex stack of its children |
| [`row`](#row) | `tern.ui.row(…)` | A horizontal flex row of its children |
| [`card`](#card) | `tern.ui.card(head, …)` | A framed box: head row (role icon, head, status chip, chevron), body, preview clamp |
| [`section`](#section) | `tern.ui.section(head, …)` | An unframed disclosure group: chevron and head over an indented body |
| [`rule`](#rule) | `tern.ui.rule(label?)` | A hairline divider, optionally labeled |
| [`spacer`](#spacer) | `tern.ui.node("spacer", { size = … })` | A fixed block of vertical space |

## Common props on layout nodes

Every node takes the common props (see [Elements](index.md)). Two groups matter most for layout: the flex props,
which size a node inside its parent `col` or `row`, and `hidden`. They go on the child, not on the stack.

| Prop | Type | Effect |
| --- | --- | --- |
| `grow` | number | Inline `flex-grow` |
| `shrink` | number | Inline `flex-shrink` |
| `basis` | number or `"content"` | A number is a fraction of the parent (`0.5` → `flex-basis: 50%`). `"content"` sets `flex-basis: auto` and `flex-shrink: 0`: the node keeps its content size. Other values are ignored |
| `min` | `{ w?, h? }` | Inline `min-width` / `min-height` |
| `max` | `{ w?, h? }` | Inline `max-width` / `max-height`. A `max.h` also adds class `sf-clip` (`overflow: hidden`) |
| `hidden` | boolean | Adds `sf-hidden` (`display: none !important`) |

`min` and `max` take extents:

| Extent | Example | CSS |
| --- | --- | --- |
| Character cells | `"40ch"` | `calc(40 * var(--sf-cw))` |
| Text lines | `"10lines"` | `calc(10 * var(--sf-lh))` |
| Fraction | `0.25` | `25%` |

Pixel strings (`"200px"`), negative numbers and other strings are ignored. `--sf-cw` and `--sf-lh` are the
surface's cell width and line height (see [Variables](../styles/variables.md)).

The flex props are written as the element's inline style, so a sheet rule needs `!important` to beat them. The
other common props become attributes: `role` → `data-role`, `tone` → `data-tone` (only a known tone: `neutral`,
`accent`, `info`, `success`, `warning`, `error`, `pending`, `muted`, `user`), `mark` → `data-mark`, `href` →
`data-href`, `title` → `title`, `aria` → `aria-label`.

## `col`

A vertical flex stack (`display: flex; flex-direction: column; min-width: 0`). Children are drawn in order straight
into the element: there is no inner wrapper. Without an `align` prop children stretch to the column's width (the
flex default).

**Empty stacks take no room.** After its children are placed, a `col` whose drawn children are all hidden or
themselves empty (or that has no children) gets class `sf-void` (`display: none !important`), so it adds no gap to
its parent either. An empty stack with `grow > 0` is kept: it acts as a flexible spacer. A virtualized column (below)
is never voided.

**Large columns virtualize.** A `col` other than the region root `main`, inside a scrolling region, without `wrap`
and without `justify`, draws only the children near the viewport once it has more than 64 children or its estimated
height passes three viewports (and 64 lines). The rest is replaced by two `div.sf-pad` spacers (`aria-hidden`) above
and below the mounted children, sized from estimated heights. Children keep their state as they scroll in and out.
You do not opt in; set `justify` or `wrap` if a column must always mount every child.

**Build it:** `tern.ui.col(children)` (`gap = "sm"`) or `tern.ui.lines(children)` (`gap = "none"`, for lines of
one text stream); see [UI Builders](../reference/ui.md#layout). Or `tern.ui.node("col", { gap = "md" }, children)`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `gap` | `"none"` \| `"xs"` \| `"sm"` \| `"md"` \| `"lg"` | `"none"` (the builders send `"sm"`) | Space between children: 0, 2px, 6px, 10px, 16px. Adds class `gap-<value>` |
| `align` | `"start"` \| `"center"` \| `"end"` \| `"baseline"` \| `"stretch"` | none (stretch) | Cross-axis alignment (`align-items`). Adds `al-<value>`; other values add nothing |
| `justify` | `"between"` \| `"end"` | none (start) | Main-axis distribution (`justify-content: space-between` / `flex-end`). Adds `js-<value>`; `"start"` and other values add nothing. Also turns virtualization off |
| `wrap` | boolean | `false` | Adds class `wrap`. On a `col` it has no style of its own (`.sf-row.wrap` is the only rule); it turns virtualization off |

An unknown `gap` still adds `gap-<value>`, which no rule matches, so the gap is 0. Sheets can define their own:
`.sf-col.gap-huge { gap: 40px }` with `gap = "huge"`.

```lua
local ui = tern.ui

local rows = {}
for _, gap in { "none", "xs", "sm", "md", "lg" } do
	table.insert(rows, ui.node("row", { gap = "md" }, {
		ui.node("text", { spans = { ui.span(gap, "muted") }, min = { w = "6ch" } }),
		ui.node("row", { gap = gap }, {
			ui.badge("build", "info"),
			ui.badge("test", "info"),
			ui.badge("deploy", "info"),
		}),
	}))
end
return { main = ui.col(rows) }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-gaps.light.png" srcset="../figures/elements-layout-gaps.light.png 2x" alt="Five rows of three badges, spaced 0, 2, 6, 10 and 16 pixels apart">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-gaps.dark.png" srcset="../figures/elements-layout-gaps.dark.png 2x" alt="Five rows of three badges, spaced 0, 2, 6, 10 and 16 pixels apart">
<figcaption>The five gaps, on rows; a column spaces its children the same way.</figcaption>
</figure>

**Children:** drawn in order, directly inside the element.

**Events:** none of its own; `actions` work as on any node.

**Styling:**

```html
<div class="sf sf-col gap-sm al-center js-between" data-id="main.list">
	<!-- children -->
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-col` |
| Gap | `.sf-col.gap-none` … `.gap-lg` |
| Alignment | `.al-start`, `.al-center`, `.al-end`, `.al-baseline`, `.al-stretch` |
| Justification | `.js-between`, `.js-end` |
| Wrap flag | `.sf-col.wrap` |
| Nothing to show | `.sf-void` |
| Virtualization spacers | `.sf-pad` (inner, may change) |

`.sf-col`, `[data-id]`, `[data-role]` and `[data-tone]` are stable hooks; the `gap-*`, `al-*`, `js-*` and `wrap`
classes follow the props. A block's region roots (`main`, `dock`, `layer`) are drawn as their children, not as a
`col` element (see [Styling views](../styles/index.md)).

```lua
local ui = tern.ui

return {
	main = ui.node("col", { gap = "md" }, {
		ui.text("Deploy"),
		ui.lines({ ui.text("step 1: build"), ui.text("step 2: upload") }),
	}),
}
```

## `row`

A horizontal flex row (`display: flex; flex-direction: row; align-items: center; min-width: 0`). Every direct child
gets `min-width: 0`, so long text shrinks and truncates instead of pushing the row wider. Children are vertically
centered unless `align` says otherwise.

Rows never virtualize. Empty rows get `sf-void` exactly like columns (see [`col`](#col)); a `row` with `grow > 0`
and no children stays as a spacer, which is the usual way to push the following children to the far end.

**Build it:** `tern.ui.row(children)` (`gap = "sm"`, see [UI Builders](../reference/ui.md#layout)), or
`tern.ui.node("row", { gap = "md", justify = "between" }, children)`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `gap` | `"none"` \| `"xs"` \| `"sm"` \| `"md"` \| `"lg"` | `"none"` (the builder sends `"sm"`) | Space between children: 0, 2px, 6px, 10px, 16px (`gap-<value>`) |
| `align` | `"start"` \| `"center"` \| `"end"` \| `"baseline"` \| `"stretch"` | none (`center` from the sheet) | `align-items` (`al-<value>`). Use `"baseline"` to line up text of different sizes, `"start"` for multi-line children |
| `justify` | `"between"` \| `"end"` | none (start) | `justify-content: space-between` / `flex-end` (`js-<value>`) |
| `wrap` | boolean | `false` | `flex-wrap: wrap` (class `wrap`): children flow onto more lines when they don't fit |

A two-line column next to a label and a badge, under four `align` values:

```lua
local ui = tern.ui

local rows = {}
for _, align in { "start", "center", "end", "baseline" } do
	table.insert(rows, ui.node("row", { gap = "md", align = align }, {
		ui.node("text", { spans = { ui.span(align, "muted") }, min = { w = "8ch" } }),
		ui.node("col", {}, { ui.text("main.rs"), ui.text("lib.rs") }),
		ui.badge("2 files", "info"),
	}))
end
return { main = ui.node("col", { gap = "lg" }, rows) }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-align.light.png" srcset="../figures/elements-layout-align.light.png 2x" alt="Four rows: the label and badge sit at the top, middle, bottom and first-line baseline of a two-line column">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-align.dark.png" srcset="../figures/elements-layout-align.dark.png 2x" alt="Four rows: the label and badge sit at the top, middle, bottom and first-line baseline of a two-line column">
</figure>

**Children:** drawn in order, directly inside the element. Size them with the [common flex props](#common-props-on-layout-nodes).

**Events:** none of its own; `actions` work as on any node.

**Styling:**

```html
<div class="sf sf-row gap-sm wrap" data-id="main.toolbar">
	<!-- children -->
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-row` |
| Children | `.sf-row > *` |
| Wrapping | `.sf-row.wrap` |
| Gap, alignment, justification | `.gap-*`, `.al-*`, `.js-*` as on `col` |
| Nothing to show | `.sf-void` |

```lua
local ui = tern.ui

return ui.node("row", { gap = "md", align = "baseline" }, {
	ui.text({ ui.span("api", "strong") }),
	ui.node("row", { grow = 1 }), -- empty and growing: pushes the badge right
	ui.badge("healthy", "success"),
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-row.light.png" srcset="../figures/elements-layout-row.light.png 2x" alt="A row with the bold name api at the left and a green healthy badge pushed to the right edge">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-row.dark.png" srcset="../figures/elements-layout-row.dark.png 2x" alt="A row with the bold name api at the left and a green healthy badge pushed to the right edge">
</figure>

## `card`

A rounded box with a hairline ring tinted by `tone`, a head row and a body. The head shows, left to right: an icon
implied by `role` (when there is one), the head content, a status chip and a disclosure chevron. The body holds the
other children in a column with `--sf-inner-gap` (8px) between them, indented to line up with the head text
(`padding: 0 12px 10px 36px`).

**Head.** `head` is either a span list (`TspText`: a string or spans) drawn into `div.sf-head`, or the id of one of
the card's own children, which is then drawn in the head instead of the body. A string that is not a child id is
plain text. In a block, child ids are `<parent id>.<key>` (or `<parent id>.<index>` without a key), so a child with
`key = "title"` under a card with id `main.build` is named `"main.build.title"`. `tern.ui.card(head, …)` always
sends `head` as spans; to name a child, set `p.head` to its id or build the card with `tern.ui.node`.

**Body.** The body keeps its bottom padding when it has no children, so a card with a head and an empty body
draws 10px of space under the head row.

**No head.** When the card has no head content, no status and is not `collapsible`, the head row is hidden (class
`nohead`) and the body takes even padding (`10px 12px`). A role icon alone does not make a head.

**Role icon.** `role` picks an icon: `lens.<family>…` roles map by family (`lens.git.log` → branch, unknown families
→ terminal), `omp.tool.<tool>…` by tool (unknown tools → plug), and any other role by its second dot-separated
segment when Tern has an icon for that name (`omp.user` → user, `plugin.search.results` → search,
`plugin.bash` → terminal). Known names include `bash`, `shell`, `edit`, `read`, `search`, `web`, `todo`, `task`,
`user` and `error`. Most plugin roles name none (`plugin.ci.job` reads `ci`), so the icon holder stays hidden. The
icon takes the tone color (`--t3` for neutral or untoned cards).

**Status chip.** `status` is one of `pending` (clock, "Pending"), `running` (a pulsing dot, "Running"), `done`
(check, "Done"), `error` (cross, "Failed") or `cancelled` (stop, "Canceled"). Other values show no chip. The card
draws no timer of its own: put an [`elapsed`](motion.md#elapsed) node in the head for one.

Every tone, with a status on some:

```lua
local ui = tern.ui

local cards = {}
for _, t in {
	{ "untoned", nil, "running" }, { "neutral", "neutral" }, { "accent", "accent" }, { "info", "info" },
	{ "success", "success", "done" }, { "warning", "warning" }, { "error", "error", "error" },
	{ "pending", "pending", "pending" }, { "muted", "muted", "cancelled" }, { "user", "user" },
} do
	table.insert(cards, ui.node("card", { head = t[1], tone = t[2], status = t[3], basis = 0.48, grow = 1 }, {
		ui.text("Body"),
	}))
end
return { main = ui.node("row", { gap = "sm", wrap = true }, cards) }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-card-tones.light.png" srcset="../figures/elements-layout-card-tones.light.png 2x" alt="Ten cards in two columns, one per tone, each ring tinted by its tone; five carry Running, Done, Failed, Pending and Canceled chips">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-card-tones.dark.png" srcset="../figures/elements-layout-card-tones.dark.png 2x" alt="Ten cards in two columns, one per tone, each ring tinted by its tone; five carry Running, Done, Failed, Pending and Canceled chips">
<figcaption>Without a program palette the fill stays <code>--sf-card-bg</code>; the tone shows in the ring.</figcaption>
</figure>

**Folding.** With `collapsible = true` the head becomes a button (`role="button"`, `tabindex="0"`,
`aria-expanded`): a click, Enter or Space flips it. ⌘-click on the head does not flip it, so links in the head still
open. Collapsed:

- without `preview`, the body and the "more" button are hidden (class `nopreview`);
- with `preview`, the body is clamped to that many lines (`preview × line height`). When the content is taller, the
  card gets class `clamped`: the body's `max-height` is `var(--sf-clamp)` with a fade over its last ~2 lines, and a
  `button.sf-more` under it reads "N more lines" (or "1 more line") with a chevron and a `title` of
  `Show all  N more lines`. Clicking it expands the card (the same local flip as the head). When the content fits,
  nothing is clamped and no button shows. A partial line counts as hidden only past a quarter of a line. The clamp
  is re-measured when the card resizes.

`collapsed` without `collapsible` does nothing: the card draws open.

```lua
local ui = tern.ui

local log = "step 1: ok\nstep 2: ok\nstep 3: ok\nstep 4: ok\nstep 5: ok"
local function build(head, p)
	p.head, p.role, p.collapsible = head, "lens.build", true
	return ui.node("card", p, { ui.ansi(log) })
end
return {
	main = ui.col({
		build("Open", { status = "done" }),
		build("Collapsed", { status = "done", collapsed = true }),
		build("Collapsed, preview 2 lines", {
			status = "error", tone = "error", collapsed = true, preview = { lines = 2 },
		}),
	}),
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-card-fold.light.png" srcset="../figures/elements-layout-card-fold.light.png 2x" alt="Three collapsible cards: open with five log lines, collapsed to its head row, and collapsed to two faded lines over a 3 more lines button">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-card-fold.dark.png" srcset="../figures/elements-layout-card-fold.dark.png 2x" alt="Three collapsible cards: open with five log lines, collapsed to its head row, and collapsed to two faded lines over a 3 more lines button">
<figcaption>The chevron points down when open and right when collapsed; <code>lens.build</code> implies the hammer icon.</figcaption>
</figure>

**Collapse state is local.** A flip by the user takes effect at once, without a round trip, and is remembered by
the node's `key` among its siblings (its id without one), not surface-wide. Deleting and adding a card with a new
id and the same key under the same parent preserves the fold; the same key under another parent has independent
state. The `collapsed` prop sets
the starting state; once the user flips it, the local state wins until your view sends a *different* `collapsed`
value, which resets it (sending the same value again changes nothing). The program hears a `toggle` event.

**Previews inside.** Kinds with their own `preview` (`ansi`, `code`, `text`, …) apply it only while collapsed:
inside an open collapsible card or section (the nearest one up the tree) their previews give way and they show in
full.

**Build it:** `tern.ui.card(head, children)` (see [UI Builders](../reference/ui.md#layout)), then set props on `p`,
or `tern.ui.node("card", { head = …, status = "running", collapsible = true }, children)`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `head` | spans, string, or a child's id | none | Head content (above) |
| `status` | `"pending"` \| `"running"` \| `"done"` \| `"error"` \| `"cancelled"` | none | Status chip; adds `.sf-chip.st-<status>` |
| `role` | string | none | `data-role`, and the head icon it implies |
| `tone` | tone name | none | `data-tone`: ring color and fill tint (below) |
| `collapsible` | boolean | `false` | The head flips the fold; adds `collapsible` and shows the chevron |
| `collapsed` | boolean | `false` | Starting fold state (needs `collapsible`); adds `collapsed` |
| `preview` | `"auto"` or `{ lines = n }` | none | Lines shown while collapsed. `"auto"` is 10; a fractional `lines` is truncated, and anything below 1 or of another shape means no preview |
| `key` | string | none | Identity among siblings; local collapse is remembered by this key under the same parent (by node id without a key) |
| `selected` | boolean | `false` | Class `selected`: an accent ring and a soft 3px accent halo |
| `inset` | boolean | `false` | Class `inset`: the body has no padding (`0 0 1px`) and its children get the card's bottom corners, so a `code`, `diff` or `table` fills the card edge to edge |
| `variant` | `"bare"` | none | Class `bare`: no ring, fill or rounding; the head is a plain line-height row with no padding and the body indents by 24px. Keeps head, status, fold and preview. For grouped and compact presentations, such as a group of rows or one file inside a larger card |

```lua
local ui = tern.ui

return {
	main = ui.node("col", { gap = "md" }, {
		ui.node("card", { head = "selected", selected = true }, { ui.text("An accent ring and halo.") }),
		ui.node("card", { head = "inset", inset = true }, { ui.code('[build]\ntarget = "release"', "toml") }),
		ui.node("card", { head = "variant = bare", variant = "bare", status = "done", collapsible = true }, {
			ui.text("A plain head row over an indented body."),
		}),
		ui.node("card", {}, { ui.text("No head: the head row hides.") }),
	}),
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-card-variants.light.png" srcset="../figures/elements-layout-card-variants.light.png 2x" alt="A selected card with a blue ring and halo, an inset card whose code block fills it edge to edge, a bare card with no frame, and a card with no head row">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-card-variants.dark.png" srcset="../figures/elements-layout-card-variants.dark.png 2x" alt="A selected card with a blue ring and halo, an inset card whose code block fills it edge to edge, a bare card with no frame, and a card with no head row">
</figure>

**Children:** the `head` child (if `head` names one) goes into `div.sf-head`; every other child goes into
`div.sf-card-body`, in order.

**Events:** `toggle` when the user flips a collapsible card (head click, Enter/Space on the focused head, or the
"more" button):

```lua
{ ev = "toggle", id = "main.build", collapsed = true, key = "build" } -- key only when the node has one
```

A block's `event(state, ev, cx)` receives it. `actions = { click = "toggle" }` on the card itself also flips it.
Otherwise `actions` work as on any node.

**Styling:**

```html
<div class="sf sf-card collapsible collapsed clamped" data-id="main.build" data-role="plugin.ci.job" data-tone="error"
	style="--sf-clamp: 200px">
	<div class="sf-card-head" role="button" tabindex="0" aria-expanded="false">
		<span class="sf-card-ic sf-hidden" aria-hidden="true"></span>
		<div class="sf-head"><!-- head spans or the head child --></div>
		<span class="sf-chip st-error"><svg class="ico">…</svg>Failed</span>
		<span class="sf-chev" aria-hidden="true"><svg class="ico">…</svg></span>
	</div>
	<div class="sf-card-body"><!-- children --></div>
	<button class="sf-more" aria-hidden="false" title="Show all  12 more lines">12 more lines<svg class="ico">…</svg></button>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-card` |
| By role / tone | `.sf-card[data-role='…']`, `.sf-card[data-tone='error']` |
| Head row | `.sf-card-head` (inner, may change) |
| Head content | `.sf-card-head > .sf-head` (inner, may change) |
| Role icon | `.sf-card-ic` (inner, may change) |
| Status chip | `.sf-chip`, `.sf-chip.st-pending` … `.st-cancelled`, running dot `.sf-chip .dot` (inner, may change) |
| Chevron | `.sf-chev` (inner, may change); hidden unless `.collapsible`, rotated −90° when `.collapsed` |
| Body | `.sf-card-body` (inner, may change) |
| "N more lines" | `.sf-more` (inner, may change); shown only in `.sf-card.clamped` |
| Folding | `.sf-card.collapsible`, `.sf-card.collapsed`, `.sf-card.nopreview`, `.sf-card.clamped` |
| Flags | `.sf-card.selected`, `.sf-card.inset`, `.sf-card.bare`, `.sf-card.nohead` |

Tone and color:

- The ring is `rgb(from var(--tc) r g b / 16%)` (20% in dark), where `--tc` is the tone color set by
  `[data-tone]`. Untoned cards use `--sf-neutral`; `tone = "neutral"` uses the plain `--l2` hairline.
- The fill is `--sf-card-bg`, replaced for `success`, `error`, `pending`, `user`, `info` and `neutral`/untoned cards
  by `--sf-tint-<tone>` when the program palette defines it (see [Variables](../styles/variables.md)).
- The body gap is `--sf-inner-gap`; the corner radius is `--r-card`; the clamp height is `--sf-clamp`, set inline
  while clamped.
- The status chip colors from `--cc`: `--sf-muted` (pending, cancelled), `--live` (running), `--sf-ok` (done),
  `--sf-bad` (error).
- A collapsible head shades with `--sf-shade` on hover.
- Children of a clamped body get `flex-shrink: 0`: a sheet that lets them shrink breaks the "N more lines" count.

The `bare` look (no fill, ring, rounding) applies inside a region (`.sf-region .sf-card.bare`).

```lua
local ui = tern.ui

local function job(j)
	local card = ui.card({ ui.span(j.name, "strong"), ui.span("  " .. j.branch, "muted") }, {
		ui.node("ansi", { text = j.log }),
	})
	local p: { [string]: any } = card.p or {}
	p.key = j.id
	p.role = "plugin.ci.job"
	p.status = j.failed and "error" or "done"
	p.tone = j.failed and "error" or nil
	p.collapsible = true
	p.collapsed = not j.failed
	p.preview = { lines = 6 }
	card.p = p
	return card
end
```

## `section`

A lighter disclosure group with no frame: a head row of a chevron and the head content over a body indented 22px
past a 1px rule on its left (`box-shadow: inset 1px 0 0 var(--l2)`). Body children sit `--sf-inner-gap` apart.

`head`, `collapsible`, `collapsed` and `key` work exactly as on [`card`](#card): the head as spans or a child's id,
the head as a button with Enter/Space and `aria-expanded` when collapsible, local collapse state kept by `key` among siblings, and
the `toggle` event. Collapsed, the body is hidden. A section has no role icon, status chip, preview clamp, "more"
button, `selected`, `inset` or `variant`; those props are ignored. The chevron always shows, pointing down while
open, even on a section that is not collapsible.

**Build it:** `tern.ui.section(head, children)` (see [UI Builders](../reference/ui.md#layout)), or
`tern.ui.node("section", { head = "Details", collapsible = true }, children)`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `head` | spans, string, or a child's id | none | Head content |
| `collapsible` | boolean | `false` | The head flips the fold; adds `collapsible` |
| `collapsed` | boolean | `false` | Starting fold state (needs `collapsible`); adds `collapsed` and `nopreview` (the body hides; a `preview` prop is ignored) |
| `key` | string | none | Identity among siblings; local collapse is remembered by this key under the same parent (by node id without a key) |

**Children:** the `head` child into `div.sf-head`, the rest into `div.sf-section-body`.

**Events:** `toggle`, as on [`card`](#card).

**Styling:**

```html
<div class="sf sf-section collapsible" data-id="main.env">
	<div class="sf-section-head" role="button" tabindex="0" aria-expanded="true">
		<span class="sf-chev" aria-hidden="true"><svg class="ico">…</svg></span>
		<div class="sf-head"><!-- head --></div>
	</div>
	<div class="sf-section-body"><!-- children --></div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-section` |
| Head row | `.sf-section-head` (inner, may change) |
| Head content | `.sf-section-head > .sf-head` (inner, may change) |
| Chevron | `.sf-section-head .sf-chev` (inner, may change); rotated −90° when collapsed |
| Body | `.sf-section-body` (inner, may change) |
| Folding | `.sf-section.collapsible`, `.sf-section.collapsed` |

The head text is `--t2`. A collapsible head turns `--t1` with an `--l1` shade on hover. The body's rule sits 7px in,
under the chevron.

```lua
local ui = tern.ui

local function env(key: string, collapsed: boolean)
	local s = ui.section({ ui.span("Environment"), ui.span(" 2", "muted") }, {
		ui.kv({ { "PATH", "/usr/bin" }, { "HOME", "/Users/me" } }),
	})
	local p: { [string]: any } = s.p or {}
	p.key = key
	p.collapsible = true
	p.collapsed = collapsed
	s.p = p
	return s
end

return { main = ui.col({ env("env", false), env("env2", true) }) }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-section.light.png" srcset="../figures/elements-layout-section.light.png 2x" alt="An open section, chevron down, over PATH and HOME indented past a hairline; below it the same section collapsed to its head, chevron right">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-section.dark.png" srcset="../figures/elements-layout-section.dark.png 2x" alt="An open section, chevron down, over PATH and HOME indented past a hairline; below it the same section collapsed to its head, chevron right">
</figure>

## `rule`

A horizontal hairline (`--l2`) one line tall (`--sf-lh`), with `role="separator"`. With a `label` the label sits
in the middle between two hairlines, in 11.5px sans `--t3`. Without one the rule is a single full-width line and
gets class `bare`.

**Build it:** `tern.ui.rule(label?)` (see [UI Builders](../reference/ui.md#layout)), or
`tern.ui.node("rule", { label = "Older" })`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `label` | spans or string | none | Centered label; span style tokens apply |

**Children:** none (ignored).

**Events:** none of its own; `actions` work as on any node.

**Styling:**

```html
<div class="sf sf-rule" data-id="main.3" role="separator">
	<span class="sf-rule-label">Older</span>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-rule` |
| Hairlines | `.sf-rule::before`, `.sf-rule::after` (the `::after` is hidden on `.sf-rule.bare`) |
| Unlabeled | `.sf-rule.bare` |
| Label | `.sf-rule-label` (inner, may change) |

```lua
local ui = tern.ui

return {
	main = ui.col({ ui.text("today"), ui.rule("Yesterday"), ui.text("yesterday"), ui.rule(), ui.text("older") }),
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-rule.light.png" srcset="../figures/elements-layout-rule.light.png 2x" alt="A labeled rule with Yesterday centered between two hairlines, and below it an unlabeled full-width hairline">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-rule.dark.png" srcset="../figures/elements-layout-rule.dark.png 2x" alt="A labeled rule with Yesterday centered between two hairlines, and below it an unlabeled full-width hairline">
</figure>

## `spacer`

A fixed block of vertical space (`flex: none`), `aria-hidden`. For flexible space inside a `row` or `col`, use an
empty stack with `grow = 1` instead (see [`row`](#row)). Tern spaces blocks and their parts itself
(`--sf-block-gap`, `--sf-inner-gap`); reach for a spacer only for space that rhythm doesn't give you.

**Build it:** `tern.ui.node("spacer", { size = "lg" })` (no dedicated builder).

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `size` | `"none"` \| `"xs"` \| `"sm"` \| `"md"` \| `"lg"` | `"md"` | Height: 0, 2px, 6px, 12px, 20px. Adds class `sz-<value>`; an unknown value matches no rule and falls back to the base 8px |

**Children:** none (ignored).

**Events:** none of its own.

**Styling:**

```html
<div class="sf sf-spacer sz-md" data-id="main.4" aria-hidden="true"></div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-spacer` |
| Size | `.sf-spacer.sz-none` … `.sz-lg` |

```lua
local ui = tern.ui

return { main = ui.col({ ui.text("header"), ui.node("spacer", { size = "lg" }), ui.text("body") }) }
```

Each size between two badges:

```lua
local ui = tern.ui

local cols = {}
for _, size in { "none", "xs", "sm", "md", "lg" } do
	table.insert(cols, ui.node("col", {}, {
		ui.badge(size, "accent"),
		ui.node("spacer", { size = size }),
		ui.badge(size, "accent"),
	}))
end
return { main = ui.node("row", { gap = "lg", align = "start" }, cols) }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-layout-spacer.light.png" srcset="../figures/elements-layout-spacer.light.png 2x" alt="Five pairs of stacked badges, none, xs, sm, md and lg, the gap inside each pair growing from 0 to 20 pixels">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-layout-spacer.dark.png" srcset="../figures/elements-layout-spacer.dark.png 2x" alt="Five pairs of stacked badges, none, xs, sm, md and lg, the gap inside each pair growing from 0 to 20 pixels">
</figure>

## Stable hooks

`.sf-col`, `.sf-row`, `.sf-card`, `.sf-section`, `.sf-rule`, `.sf-spacer`, `[data-id]`, `[data-role]`,
`[data-tone]`, `[data-mark]`, `[data-href]` and the region's `[data-surface]` are stable. State classes that follow
props (`gap-*`, `al-*`, `js-*`, `wrap`, `sz-*`, `collapsible`, `collapsed`, `selected`, `inset`, `bare`) follow the
props above. Classes on inner parts (`.sf-card-head`, `.sf-head`, `.sf-card-ic`, `.sf-chip`, `.sf-chev`,
`.sf-card-body`, `.sf-more`, `.sf-section-head`, `.sf-section-body`, `.sf-rule-label`, `.sf-pad`) are Tern's
structure: inner, may change between versions. See [Styling views](../styles/index.md) and
[Supported CSS](../styles/css.md).
