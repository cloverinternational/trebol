# HTML Elements

`el` draws plain HTML elements from a fixed list of tags, styled by your own
CSS. Reach for it when no other kind describes what you want: a form with
checkboxes and radios, a bespoke widget, a grid of your own design. For
anything a built-in kind already draws (lists, tables, key/value pairs,
badges), prefer the kind: it brings Tern's look, keyboard and copy behavior
for free.

| Kind | Builder | Draws |
| --- | --- | --- |
| [`el`](#el) | `tern.ui.el(tag, props?, children?)` or `tern.ui.node("el", { tag = … })` | One HTML element of an allowed tag, its `text`, then its children; `input` draws a checkbox or radio control |

## `el`

An `el` is one element: `<tag class="sf sf-el …your classes" data-id="<id>">`.
Tern adds nothing to it beyond the user-agent defaults of the tag (see
[Tags](#tags)), the region's font, and the default look of labels and
controls (see [Default look](#default-look)). Everything else comes from your
stylesheets.

**Build it:** `tern.ui.el(tag, props, children)` (see
[UI Builders](../reference/ui.md#el)). The builder copies every key of
`props` except `tag` into the node, so `tern.ui.el("p", { text = "Hi" })` is
`{k = "el", p = {tag = "p", text = "Hi"}}`. `tern.ui.node("el", { tag = "p",
text = "Hi" })` builds the same node.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tag` | string | `"div"` | The element, one of the [allowed tags](#tags). `form` draws as a `div` that groups controls; `input` with `type` `checkbox` or `radio` draws a [control](#controls). Any other tag (or `input` of another type) draws as a `div` and is reported (see [Unknown tags](#unknown-tags)). |
| `class` | string | none | Space-separated class names for your stylesheets. `sf` and any `sf-*` class are Tern's and are dropped. Classes removed from the prop are removed from the element on the next update. |
| `attrs` | table of string → string, number or boolean | none | Extra attributes from an [allowlist](#attributes): `data-*`, `aria-*`, `role`, `colspan`, `rowspan`. Other names and other value types are ignored. |
| `text` | string | `""` | Plain text drawn as a text node **before** the children. An empty string removes it. |
| `type` | `"checkbox"` \| `"radio"` | none | `input` only: the control's type. |
| `name` | string | none | `input` only: the control's name in its form's `values` and its radio group. An empty string counts as none. |
| `value` | string | `"on"` | `input` only: the value it reports in `change` and in `values`. |
| `checked` | boolean | `false` | `input` only: the checked state you set (see [Local state](#local-state-and-checked)). |
| `disabled` | boolean | `false` | `input` only: drawn dimmed, never flips, left out of `values`. |

Every [common prop](index.md) applies too. On an `el` they matter like this:

| Common prop | Effect on the element |
| --- | --- |
| `role` | `data-role="…"` for your selectors (not the ARIA role; for that use `attrs.role`) |
| `tone` | `data-tone="…"` for a known tone (`neutral`, `accent`, `info`, `success`, `warning`, `error`, `pending`, `muted`, `user`); others set nothing |
| `mark` | `data-mark="…"` |
| `href` | `data-href="…"`: ⌘-click opens it, as an `href` span does |
| `title` | `title="…"`: the hover tooltip |
| `aria` | `aria-label="…"`: the element's accessible name |
| `hidden` | adds `.sf-hidden` (`display: none`) |
| `key` | identity among siblings; a control's local flips are remembered by this key under its parent, not surface-wide |
| `actions` | makes the element a click target, with `.sf-act` while it has a `click` or `dblclick` (see [Actions](#actions-on-any-el)) |
| `grow`, `shrink`, `basis`, `min`, `max` | inline flex and size styles, as on any node |

**Children:** any kinds, drawn in order after `text`. `input` and `hr` draw
none (their children are ignored).

**Events:** `change` from controls (see [The `change`
event](#the-change-event)); `action`, `select` and `activate` from
`actions`, carrying the form's `values` inside a `form`. The unknown-tag
`error` is protocol traffic: a plugin block's `event` handler never sees it.

### Tags

The element Tern creates for each tag, its user-agent defaults and the role
assistive technology reads. Defaults come from Tern's user-agent sheet, a
subset of Chrome's; text inherits the region's font (the terminal mono face
at `--sf-fs`, line height `--sf-lh`), so `em` sizes are relative to that.
`--sf-fs` is 13 CSS px: the region is zoomed by the terminal's font size
over 13, so 13px draws at the terminal's size and every other length scales
with it. Kit's base sheet, which Tern's windows load, resets `button` (see
the note) and makes every box `box-sizing: border-box`.

| Tag | Draws as | Display | UA margins, padding, font | Role |
| --- | --- | --- | --- | --- |
| `div` | `div` | block | none | generic |
| `span` | `span` | inline | none | generic |
| `p` | `p` | block | margin `1em 0` | paragraph |
| `section` | `section` | block | none | region when named (`aria`, `title` or `aria-labelledby`), else generic |
| `header` | `header` | block | none | banner; section header inside `article`, `aside`, `main`, `nav` or `section` |
| `footer` | `footer` | block | none | content info; section footer inside those |
| `nav` | `nav` | block | none | navigation |
| `aside` | `aside` | block | none | complementary |
| `main` | `main` | block | none | main |
| `article` | `article` | block | none | article |
| `figure` | `figure` | block | margin `1em 40px` | figure |
| `blockquote` | `blockquote` | block | margin `1em 40px` | blockquote |
| `ul` | `ul` | block | margin `1em 0`, `padding-left: 40px`, `disc` bullets (`circle` nested once, `square` twice); nested lists lose their vertical margin | list |
| `ol` | `ol` | block | margin `1em 0`, `padding-left: 40px`, `decimal` numbers | list |
| `li` | `li` | list-item | none | list item |
| `dl` | `dl` | block | margin `1em 0` | description list |
| `dt` | `dt` | block | none | term |
| `dd` | `dd` | block | `margin-left: 40px` | definition |
| `h1` | `h1` | block | `2em`, bold, margin `0.67em 0` | heading |
| `h2` | `h2` | block | `1.5em`, bold, margin `0.83em 0` | heading |
| `h3` | `h3` | block | `1.17em`, bold, margin `1em 0` | heading |
| `h4` | `h4` | block | bold, margin `1.33em 0` | heading |
| `pre` | `pre` | block | `white-space: pre`, margin `1em 0`, monospace | generic |
| `code` | `code` | inline | monospace | code |
| `kbd` | `kbd` | inline | monospace | generic |
| `strong`, `b` | `strong`, `b` | inline | `font-weight: bolder` | generic |
| `em`, `i` | `em`, `i` | inline | italic | generic |
| `del` | `del` | inline | line-through | content deletion |
| `mark` | `mark` | inline | yellow background, black text | mark |
| `hr` | `hr` | block | margin `0.5em auto`, 1px inset gray border, no children | splitter |
| `table` | `table` | table | `border-collapse: separate`, `box-sizing: border-box` | table |
| `thead` | `thead` | table-header-group | `vertical-align: middle` | row group |
| `tbody` | `tbody` | table-row-group | `vertical-align: middle` | row group |
| `tr` | `tr` | table-row | none | row |
| `th` | `th` | table-cell | padding `1px`, bold, centered | column header (`scope` can't be set, see note) |
| `td` | `td` | table-cell | padding `1px` | cell |
| `label` | `label` | inline-flex (Tern) | `gap: 6px`, items centered | generic; names the controls inside it |
| `button` | `button` | inline-block | see note | button |
| `form` | `div` | block | none | generic |
| `input` | `span` | inline-block (Tern) | 15px control, see [Default look](#default-look) | checkbox or radio |

Notes:

- **`form`** draws as a plain `div`. What makes it a form is the grouping: the
  controls inside it (not inside a nested `form`) are its radio groups and
  its [`values`](#form-values).
- **`input`** is never a text field: `type = "checkbox"` or `"radio"` draws
  a `span` control. Any other type draws an empty `div` and reports
  `unknown el tag input type <type>` (`unknown el tag input` when `type` is
  missing). For text entry use the [`input` kind](input.md).
- **`button`** is a real `button` element (button role, named by its
  content), but it does nothing until you give it `actions`. Kit's base
  sheet, which Tern's windows load, resets the UA look: no background, no
  border, no padding, `text-align: inherit`, and the font and color of its
  parent. Style it yourself.
- **Table parts** (`table`, `thead`, `tbody`, `tr`, `th`, `td`) build a real
  table layout. `colspan` and `rowspan` are settable through `attrs`. `scope`
  is not on the allowlist, so every `th` reads as a column header. For data
  tables prefer the [`table` kind](data.md#table), which sizes, scrolls and
  copies.
- **`hr`** takes no children and no `text`.
- There is no `a`, `img`, `textarea` or `select`. Links: an `href` common
  prop or `href` spans in a [`text` node](text.md); images: the
  [`image` kind](data.md#image).
- **At the top level of a region** an `el` is a flex item: `main` is a flex
  column with a 16px gap between its nodes, and a `ui.col` is a flex column
  too. Inline tags there stretch to the full width (a top-level `mark`
  paints the whole row), margins don't collapse, and `hr`'s `auto` side
  margins shrink it to nothing. Put your elements inside one container `el`
  (a `div` or `form`), as the recipes do, to get normal block flow.

The text tags with only these defaults, inside one `div`:

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-el-text-tags.light.png" srcset="../figures/elements-el-text-tags.light.png 2x" alt="Headings h1 to h4 in decreasing sizes, a paragraph with strong, b, em, i, del, mark, code and kbd runs, a nested bulleted list with disc, circle and square markers, a numbered list, a description list with an indented definition, an indented blockquote, a pre line keeping its spaces, and a gray horizontal rule">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-el-text-tags.dark.png" srcset="../figures/elements-el-text-tags.dark.png 2x" alt="Headings h1 to h4 in decreasing sizes, a paragraph with strong, b, em, i, del, mark, code and kbd runs, a nested bulleted list with disc, circle and square markers, a numbered list, a description list with an indented definition, an indented blockquote, a pre line keeping its spaces, and a gray horizontal rule">
<figcaption>User-agent defaults in the terminal font. <code>mark</code> stays yellow on black in both themes; <code>code</code>, <code>kbd</code> and <code>pre</code> change nothing until your sheet sets another font.</figcaption>
</figure>

### Unknown tags

A tag outside the list draws as a `div` (its classes, attributes, `text` and
children as usual); an `input` of another type, or with no `type`, draws as
an empty `div` (classes and attributes, no `text`, no children). Tern sends
`{ev = "error", id, msg = "unknown el tag <tag>"}` (`"unknown el tag input
type <type>"` for a typed input, `"unknown el tag input"` for an untyped
one), once per node version: a redraw sends nothing, a change to the node
sends it again. Plugin block handlers do not receive
`error` events; check the tag list instead, or watch the surface traffic with
the tools in [Debugging](../guides/debugging.md).

### Changing `tag`

A different `tag` is a different element: Tern drops the old element and
builds a new one with the same id, `text` and children. Anything that lived
in the old element (hover, a running CSS transition) starts over. Classes,
attributes and `text` patch in place when only they change.

### Attributes

`attrs` sets attributes on the element. A name is allowed when it is:

| Name | Allowed |
| --- | --- |
| `data-<x>` | when `<x>` is non-empty lowercase ASCII letters, digits, `-` or `_` |
| `aria-<x>` | same rule for `<x>` |
| `role` | on any element except a control (a control's role is `checkbox` or `radio`) |
| `aria-labelledby` | on any element except a control (Tern sets it, see [Accessibility](#accessibility)) |
| `colspan`, `rowspan` | always |

Values are strings, numbers (written as `2`, `1.5`) or booleans (written
`true`/`false`); tables, arrays and nil are ignored. Attributes dropped from
`attrs` are removed on the next update.

Tern owns these attributes, and `attrs` never sets them: `data-id`,
`data-role`, `data-tone`, `data-mark`, `data-href`, `data-scope`,
`aria-label`, `aria-checked`. Use the common props `role`, `tone`, `mark`,
`href` and `aria` for the ones that have one. Everything else (`id`,
`style`, `onclick`, `href`, `src`, `type`, `title`, …) is ignored; `title`
has its own common prop.

```lua
ui.el("td", {
	class = "num",
	attrs = { colspan = 2, ["data-col"] = "size", ["aria-sort"] = "descending" },
	text = "4.2 MB",
})
-- <td class="sf sf-el num" data-id="…" colspan="2" data-col="size" aria-sort="descending">4.2 MB</td>
```

### Text before children

`text` is one text node, the element's first child, followed by the
children's elements in order. It is the node's primary text, so `splice` ops
edit it and `copy` reads it first. To style a part of the text, make that
part a child:

```lua
ui.el("p", { class = "lead", text = "Deploy to " }, {
	ui.el("strong", { text = "production" }),
	ui.el("span", { text = "?" }),
})
-- <p class="sf sf-el lead">Deploy to <strong class="sf sf-el">production</strong><span class="sf sf-el">?</span></p>
```

`text` is plain: no spans, tones or links. For styled runs use a
[`text` node](text.md) as a child.

### Controls

`tag = "input"` with `type = "checkbox"` or `type = "radio"` is a control.
It draws as an empty `span` with `role="checkbox"` or `role="radio"`,
`aria-checked`, `aria-disabled`, and the attributes `checked` and
`disabled` while they apply. It has no children and no `text`; put its label
next to it inside a `label`.

**Pointer-only.** A control has no `tabindex` and never takes focus, so a
click on it never takes the keys from you: arrows and Space still reach your
block's `key` handler. If you want keyboard selection, handle the keys and
set `checked` yourself.

**Clicks.**

- A click on a checkbox toggles it.
- A click on a radio checks it; the other radios of its group uncheck on
  the next sync, as its `change` is sent. A checked radio stays checked
  when clicked again (no event).
- A click anywhere else in a `label` flips the first control drawn inside
  it. A click on a control inside a label is that control's alone, so a
  label with two controls flips only the one clicked (or the first, when the
  click lands on the label's text).
- A click on a disabled control does nothing, not even in a label holding
  other controls. A click on a label whose first control is disabled does
  nothing either.

The flip shows at once, before your code runs; `change` follows on the next
sync.

**Radio groups.** A radio's group is the other radios with the same `name`:

| Where the radio is | Its group |
| --- | --- |
| Inside a `form` | Same-named radios of the nearest enclosing `form`, not those in a `form` nested inside it |
| Outside every `form` | Same-named radios outside every `form` in the view's document |
| No `name` (or `name = ""`) | No group: clicking it only checks it |

Two forms can both have a `size` group; they never uncheck each other.

**Inert controls.** Controls flip only while their surface is open and its
program listens. A closed surface (a block that ended, its view still on
screen) and a surface opened with `listen:false` keep every control as
drawn, and send nothing. A lens view is drawn inside the terminal's command
block, which is a closed surface, so controls in a lens view never flip
either: give a lens view `actions` instead, which reach its `event` handler.

### Local state and `checked`

A click's flip is local state, remembered by the node's `key` among its
siblings (else by its id), the way a card's fold is. Deleting and adding a
node with a new id and the same key under the same parent preserves the
flip; the same key under another parent has independent state.
Your `checked` prop stays the owner:

- **A change of `checked` wins.** When a node arrives with a `checked`
  different from the one last drawn, Tern drops the local flip and draws your
  value. A radio set to `true` this way also drops its group's flips, so the
  others show their own `checked`.
- **Other props keep the flip.** An update that changes `class`, `text` or
  anything but `checked` leaves the user's choice on screen.
- **Mirror `change` to stay in charge.** Store `ev.checked` (or
  `ev.values`) in your state and render it as `checked`. The view then
  matches what the user sees, and later changes of yours take effect.

If you never mirror, a user's flip survives redraws until you change
`checked`. If you render `checked = state.x` and `state.x` never changes, a
reset to the same value does nothing: change it (or the node's `key`) to
force it.

### The `change` event

Each flip sends, on the next sync:

```lua
{
	ev = "change",
	id = "<the control's id>",
	name = "size",        -- only when the control has a name
	value = "large",      -- its value ("on" by default)
	checked = true,       -- its new state
	values = { … },       -- only inside a form: the form's values after the flip
}
```

A checked radio unchecks its group before the event, so `values` already
shows the new pick. A plugin block receives it in `event(state, ev, cx)`.

### Form values

Every `action`, `select`, `activate` and `change` event from a node inside
an `el` `form` carries `values`: the form's controls as they are drawn at
that moment, the user's flips included. The algorithm:

1. Take the nearest `form` around the node (the node itself when it is the
   form). Outside every form there are no `values`.
2. Walk the form's subtree in document order, skipping nested forms and
   everything in them. Keep each control that is enabled and has a `name`.
3. Group them by `name`, in the order each name first appears.
4. For each group:
   - If any member is a radio: the `value` of the checked radio, or `nil`
     (`null` on the wire) when none is checked. Checkboxes in that group are
     ignored.
   - Else, one checkbox: `true` or `false`.
   - Else, several checkboxes: an array of the checked ones' `value`s in
     document order (an empty array when none is checked).

Worked example:

```lua
ui.el("form", {}, {
	ui.el("input", { type = "radio", name = "size", value = "s" }),
	ui.el("input", { type = "radio", name = "size", value = "l" }),
	ui.el("input", { type = "checkbox", name = "notify", checked = true }),
	ui.el("input", { type = "checkbox", name = "tags", value = "a", checked = true }),
	ui.el("input", { type = "checkbox", name = "tags", value = "b" }),
	ui.el("input", { type = "checkbox", name = "tags", value = "c", checked = true }),
	ui.el("input", { type = "checkbox", name = "off", checked = true, disabled = true }),
	ui.el("input", { type = "checkbox", checked = true }),
	ui.el("button", { text = "Go", actions = { click = "submit" } }),
})
```

A click on Go sends `{ev = "action", act = "submit", values = {notify =
true, tags = {"a", "c"}}}` (`size` is present but `nil`, so a Lua table
doesn't show it; `off` is disabled and the last box has no name). After the
user clicks `l` and `b`, Go sends `values = {size = "l", notify = true, tags =
{"a", "b", "c"}}`. A button outside the form sends no `values`.

### Actions on any `el`

`actions` work on every `el`, not only `button`: a `div` row, an `li`, a
`td`. `{click = "show"}` sends `{ev = "action", id, act = "show"}`, with
`mods` when modifier keys were held and `values` inside a form. The
triggers are `click` and `dblclick` (one action id each) and `menu` (a list
of action ids for the right-click menu, which gets a Copy item unless it
lists `copy`); see [Views](../guides/views.md) and the [common
props](index.md). Tern keeps `toggle`, `copy`, `open` and `zoom` for itself
and sends `select` and `activate` as their own events; pick another name for
an action of yours. A `button` is the natural choice: it reads as a button to
assistive technology.

```lua
ui.el("li", { class = "file", text = path, actions = { click = "show", dblclick = "edit" } })
```

### Accessibility

- Each tag has its native role (see [Tags](#tags)). `attrs.role` overrides
  it with an ARIA role name on any element but a control.
- `aria` (common prop) sets `aria-label`, the element's name. Other `aria-*`
  attributes go through `attrs` (`aria-hidden`, `aria-describedby`,
  `aria-expanded`, …).
- A `label` gets an `id` derived from the surface and its node id. A control
  inside a label, with no `aria` of its own, gets `aria-labelledby`
  pointing at its nearest enclosing label, so it is named by the label's
  text. A control with `aria` is named by that instead.
- To name another element by a label, set `attrs["aria-labelledby"]`; you
  can't read the generated `id`, so for anything but controls prefer
  `aria`.
- Controls report `aria-checked` and `aria-disabled` as they flip.

### Default look

What Tern draws before your styles:

- `label`: `inline-flex`, items centered, `gap: 6px`, default cursor.
- Checkbox: a 15×15px square, radius 4px, `--card`-colored (a faint white
  wash in dark) with a 1px `--l4` inset ring that turns `--t4` on hover.
  Checked: `--accent-fill` background with a white check, which scales in.
- Radio: the same, round, with a white dot when checked.
- Disabled: `opacity: 0.45` on the control only; its label text stays as
  drawn.
- No focus ring: controls never take focus.

Other tags have only their user-agent defaults.

Each control in its own `label` inside a `form` laid out as a two-column
grid; one cell is:

```lua
ui.el("label", {}, {
	ui.el("input", { type = "checkbox", name = "b", checked = true }),
	ui.el("span", { text = "Checked" }),
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-el-controls.light.png" srcset="../figures/elements-el-controls.light.png 2x" alt="A checkbox column and a radio column: unchecked, checked with an accent fill and white check or dot, disabled and faded, and checked and disabled, faded">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-el-controls.dark.png" srcset="../figures/elements-el-controls.dark.png 2x" alt="A checkbox column and a radio column: unchecked, checked with an accent fill and white check or dot, disabled and faded, and checked and disabled, faded">
<figcaption>Checkboxes and radios with no stylesheet of yours: unchecked, checked, disabled, checked and disabled.</figcaption>
</figure>

### Styling

```html
<div class="sf-region sf-main" data-scope="…" data-surface="plugin.shop.order">
	<div class="sf sf-el order" data-id="f">            <!-- tag "form" -->
		<p class="sf sf-el" data-id="q">Pick a size</p>
		<label class="sf sf-el opt" data-id="s" id="…-s">
			<span class="sf sf-el" data-id="s.r" role="radio" aria-checked="true"
				checked aria-disabled="false" aria-labelledby="…-s"></span>
			<span class="sf sf-el" data-id="s.t">Small</span>
		</label>
		<button class="sf sf-el sf-act go" data-id="go" data-role="shop.submit">Order</button>
	</div>
</div>
```

| Target | Selector |
| --- | --- |
| Any `el` | `.sf-el` |
| A tag | `p.sf-el`, `label.sf-el`, `button.sf-el` (`form` is `div.sf-el`) |
| Your classes | `.order`, `.opt` |
| By id or role | `[data-id='go']`, `[data-role='shop.submit']` |
| Your attributes | `[data-col='size']`, `[aria-sort]` |
| A control | `.sf-el[aria-checked]` |
| A checkbox / radio | `[role='checkbox']`, `[role='radio']` |
| Checked | `:checked` (same as `[checked]`) or `[aria-checked='true']` |
| Disabled | `:disabled` (same as `[disabled]`) |
| Hidden | `.sf-hidden` |
| Tone | `[data-tone='warning']` |
| Your block only | prefix with `[data-surface='plugin.<plugin>.<block>']` |

These are all stable hooks: `.sf-el`, the tag, your classes and attributes,
`[data-id]`, `[data-role]`, `[data-tone]`, `[data-mark]`, `[data-href]`
and the region's `[data-surface]`. The label's generated `id` is not: don't
select on it. Tern's sheets have no `:has()`; style a label by its checked
control with a sibling selector (`:checked + span`), as the recipes below
do. See [Styling views](../styles/index.md), [CSS
variables](../styles/variables.md) and [Supported CSS](../styles/css.md).

## Recipe: a styled form

A block `ask` of plugin `deploy` that asks for a deploy target and options,
styled from the manifest.

`plugin.toml`:

```toml
schema = 1
id = "deploy"
name = "Deploy"
version = "0.1.0"
host = "host.luau"
styles = ["deploy.css"]

[[blocks]]
id = "ask"
title = "Deploy"
```

`host.luau`:

```lua
local ui = tern.ui

local function radio(state, value, label)
	return ui.el("label", { class = "opt" }, {
		ui.el("input", { type = "radio", name = "env", value = value, checked = state.env == value }),
		ui.el("span", { text = label }),
	})
end

local function check(state, name, label, disabled)
	return ui.el("label", { class = "opt" }, {
		ui.el("input", { type = "checkbox", name = name, checked = state[name], disabled = disabled }),
		ui.el("span", { text = label }),
	})
end

tern.block.define("ask", {
	init = function(_cx, _args, saved)
		return saved or { env = "staging", migrate = true, notify = false }
	end,
	view = function(state, _cx)
		return { main = ui.col({
			ui.el("form", { class = "deploy" }, {
				ui.el("h3", { text = "Deploy" }),
				ui.el("p", { class = "hint", text = "Pick where the build goes." }),
				ui.el("div", { class = "group", aria = "Environment", attrs = { role = "radiogroup" } }, {
					radio(state, "staging", "Staging"),
					radio(state, "production", "Production"),
				}),
				check(state, "migrate", "Run migrations"),
				check(state, "notify", "Notify the channel", state.env ~= "production"),
				ui.el("div", { class = "actions" }, {
					ui.el("button", { class = "go", text = "Deploy", actions = { click = "deploy" } }),
					ui.el("button", { class = "cancel", text = "Cancel", actions = { click = "cancel" } }),
				}),
			}),
		}) }
	end,
	event = function(state, ev, cx)
		if ev.ev == "change" then
			-- mirror the flip so `checked` stays yours
			if ev.name == "env" then
				state.env = ev.value
			else
				state[ev.name] = ev.checked
			end
		elseif ev.ev == "action" and ev.act == "deploy" then
			local v = ev.values
			cx:toast("info", "Deploying to " .. v.env, v.migrate and "with migrations" or nil)
			cx:exit(0)
		elseif ev.ev == "action" and ev.act == "cancel" then
			cx:exit(1)
		end
	end,
})
```

A disabled checkbox is left out of `values`, so
`v.notify` is `nil` while staging is picked.

`deploy.css`:

```css
[data-surface='plugin.deploy.ask'] .deploy {
	display: flex;
	flex-direction: column;
	gap: 8px;
	max-width: calc(48 * var(--sf-cw, 8px));
	padding: 10px 12px;
	border-radius: 8px;
	background: var(--card);
	box-shadow: inset 0 0 0 1px var(--l2);
	font-family: var(--sans);
}

[data-surface='plugin.deploy.ask'] .deploy h3 {
	margin: 0;
	font-size: 13px;
}

[data-surface='plugin.deploy.ask'] .hint {
	margin: 0;
	color: var(--t3);
}

[data-surface='plugin.deploy.ask'] .group {
	display: flex;
	gap: 14px;
}

[data-surface='plugin.deploy.ask'] .opt :checked + span {
	color: var(--accent);
}

[data-surface='plugin.deploy.ask'] .opt [role='checkbox']:disabled + span {
	color: var(--t4);
}

[data-surface='plugin.deploy.ask'] .actions {
	display: flex;
	gap: 8px;
	margin-top: 4px;
}

[data-surface='plugin.deploy.ask'] button.sf-el {
	padding: 3px 12px;
	border-radius: 6px;
	box-shadow: inset 0 0 0 1px var(--l4);
}

[data-surface='plugin.deploy.ask'] button.sf-el:hover {
	background: var(--l2);
}

[data-surface='plugin.deploy.ask'] button.go {
	background: var(--accent-fill);
	box-shadow: none;
	color: #fff;
}
```

The `[data-surface='plugin.<plugin>.<block>']` prefix keeps the rules on this
block's regions; without it they would reach every surface with the same
classes. The group's name goes in the `aria` common prop: `aria-label` is
Tern's, so `attrs` can't set it.

On first open (staging picked, migrations on, notify disabled):

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-el-form.light.png" srcset="../figures/elements-el-form.light.png 2x" alt="A card titled Deploy with the hint Pick where the build goes, radios Staging (checked, accent text) and Production, a checked Run migrations checkbox in accent text, a faded disabled Notify the channel checkbox, and an accent Deploy button beside an outlined Cancel button">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-el-form.dark.png" srcset="../figures/elements-el-form.dark.png 2x" alt="A card titled Deploy with the hint Pick where the build goes, radios Staging (checked, accent text) and Production, a checked Run migrations checkbox in accent text, a faded disabled Notify the channel checkbox, and an accent Deploy button beside an outlined Cancel button">
</figure>

## Recipe: a segmented control

Radios whose box is hidden, each label drawn as a segment. A click anywhere
on a segment flips its radio, because a label click flips the first control
inside it, hidden or not.

```lua
local ui = tern.ui

local function segmented(name, current, options)
	local segs = {}
	for _, o in ipairs(options) do
		segs[#segs + 1] = ui.el("label", { class = "seg" }, {
			ui.el("input", { type = "radio", name = name, value = o.value, checked = current == o.value }),
			ui.el("span", { text = o.label }),
		})
	end
	return ui.el("div", { class = "segs", aria = name, attrs = { role = "radiogroup" } }, segs)
end

-- in view:
segmented("view", state.view, {
	{ value = "list", label = "List" },
	{ value = "grid", label = "Grid" },
	{ value = "tree", label = "Tree" },
})

-- in event:
if ev.ev == "change" and ev.name == "view" then
	state.view = ev.value
end
```

Outside a form, radios named `view` form one group across the view; wrap the
control in its own `ui.el("form", …)` if another `view` group exists.

```css
[data-surface='plugin.files.browse'] .segs {
	display: inline-flex;
	align-self: flex-start;
	padding: 2px;
	gap: 2px;
	border-radius: 7px;
	background: var(--l2);
}

[data-surface='plugin.files.browse'] .seg {
	gap: 0;
}

[data-surface='plugin.files.browse'] .seg [role='radio'] {
	display: none;
}

[data-surface='plugin.files.browse'] .seg span {
	padding: 2px 10px;
	border-radius: 5px;
	color: var(--t3);
}

[data-surface='plugin.files.browse'] .seg span:hover {
	color: var(--t1);
}

[data-surface='plugin.files.browse'] .seg :checked + span {
	background: var(--card);
	color: var(--t1);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
```

`align-self: flex-start` keeps the control its own width when it sits in a
flex column (`main`, a `ui.col`), which would otherwise stretch it.

With `state.view = "grid"`:

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-el-segmented.light.png" srcset="../figures/elements-el-segmented.light.png 2x" alt="A segmented control on a gray track with List, Grid and Tree; Grid is a raised white segment">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-el-segmented.dark.png" srcset="../figures/elements-el-segmented.dark.png 2x" alt="A segmented control on a gray track with List, Grid and Tree; Grid is a raised white segment">
</figure>

## Recipe: a key/value grid

A definition list laid out as a two-column grid, with a tone on one value.

```lua
local function grid(rows)
	local kids = {}
	for _, r in ipairs(rows) do
		kids[#kids + 1] = ui.el("dt", { text = r[1] })
		kids[#kids + 1] = ui.el("dd", { text = r[2], tone = r.tone, title = r.title })
	end
	return ui.el("dl", { class = "facts" }, kids)
end

grid({
	{ "Branch", "main" },
	{ "Commit", "4f2a9c1", title = "4f2a9c1e0b…" },
	{ "Status", "failing", tone = "error" },
})
```

```css
[data-surface='plugin.ci.run'] dl.facts {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 2px 16px;
	margin: 0;
}

[data-surface='plugin.ci.run'] .facts dt {
	color: var(--t3);
}

[data-surface='plugin.ci.run'] .facts dd {
	margin: 0;
}

[data-surface='plugin.ci.run'] .facts dd[data-tone='error'] {
	color: var(--bad);
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-el-grid.light.png" srcset="../figures/elements-el-grid.light.png 2x" alt="Two columns: dim keys Branch, Commit and Status; values main, 4f2a9c1 and failing in red">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-el-grid.dark.png" srcset="../figures/elements-el-grid.dark.png 2x" alt="Two columns: dim keys Branch, Commit and Status; values main, 4f2a9c1 and failing in red">
</figure>

For a plain key/value list with Tern's look and copy, the
[`kv` kind](data.md#kv) is shorter.
