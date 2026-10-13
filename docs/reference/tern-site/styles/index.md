# Styling Views

Tern draws every view node as ordinary elements styled by CSS sheets. Your
plugin can add sheets of its own and restyle anything it draws: a block's
regions, a lens view, a single node with a `role`. This page covers where
sheets come from, how they cascade, the DOM a view makes, every class and
attribute you can target, and recipes for common restyles.

Related pages:

- [CSS Variables](variables.md): the theme, surface and palette variables to
  color with, and how light and dark work.
- [Supported CSS](css.md): the properties, values, selectors and at-rules
  Tern understands.
- The element pages (`../elements/*.md`): the exact DOM of each node kind,
  starting at [Elements](../elements/index.md).
- [Chrome and Styling](../guides/chrome.md#global-css): installing sheets
  from a plugin, and styling status segments.

## Where sheets come from

### Plugin sheets

A plugin's sheets are **global**: they apply to the whole window, not only to
your views. Tern installs them as they are, without any scoping.
Every selector you write must scope itself, usually with your block's
`[data-surface]` or your nodes' `[data-role]`.

| Source | Sheet name | Reaches |
| --- | --- | --- |
| Manifest `styles` | `plugin:local:<id>:styles` | Every window on this machine. Installed at load, before the window entry runs, and kept when the window entry fails. Empty styles install no sheet. |
| `tern.css(name, source)` from a window half | `plugin:local:<id>:<name>` | Every window on this machine. `name` is letters, digits, `_` and `-`, not `styles`; any other name raises. Calling it again with the same name replaces the sheet in place; an empty source leaves an empty sheet. |
| An attached remote host's Ready plugin, manifest `styles` | `plugin:<slot>:<id>:styles` | Your windows attached to that host. Only manifest styles travel; `tern.css` runs in window halves, which don't run for remote hosts. |
| The web tab | `plugin:0:<id>:styles` | The web tab runs no Lua, so it installs the manifest `styles` of the Ready plugins of the daemon that served it. `tern.css` sheets never reach it. |

Names, limits and reload order are in
[Chrome and Styling](../guides/chrome.md#global-css). Parse errors don't
raise: Tern logs `plugin style sheet has errors` with the sheet's name, drops
the bad rules and declarations, and applies the rest.

`@keyframes` names in plugin sheets are global too: a sheet that defines a
name already defined replaces those keyframes for everyone. Prefix yours
with your plugin id (`todo-pulse`).

### Program sheets (TSP `s`)

A program that isn't a plugin (omp, or any tool speaking the Tern Surface
Protocol on its pty) sends sheets with the `s` verb
([Stylesheets](../protocol/theme.md#stylesheets)):

```text
ESC _ tsp;s;{"sf":"s1","name":"main","css":"…"} ESC \
```

These sheets are **confined to the surface**. Each view has a scope token
`sf<N>`, set as `data-scope` on its three regions. Tern installs the sheet as
`tsp:<token>:<name>` and gives every selector a leading
`[data-scope="sf<N>"]` ancestor, which adds no specificity. So `.ask label`
matches only inside that surface's `main`, `dock` and `layer`. The rules
match strict descendants of a region, never the region element itself: a
program sheet can't restyle `.sf-main`.

Confinement also drops every declaration that could reach outside the
surface: any value holding `url()` (backgrounds, masks, `filter: url(#…)`,
custom properties), `position: fixed`, and `position: var(…)`. The sheet's
own `@keyframes` are private to it: its `animation-name`s find them, other
sheets don't, and a name it doesn't define resolves globally.

Parse errors and dropped declarations come back to the program once per
sheet version, joined with `; ` in one event:

```text
{"ev":"error","sf":"s1","sheet":"main","msg":"3:1: position: fixed dropped: position outside the surface; 3:1: url() dropped: background-image outside the surface"}
```

| | Plugin sheets | Program sheets (`s`) |
| --- | --- | --- |
| Scope | The whole window | Inside one surface's regions |
| Who scopes selectors | You, with `[data-surface]` / `[data-role]` | Tern, with `[data-scope]` |
| `url()`, `position: fixed` | Allowed | Dropped |
| `@keyframes` | Global | Private to the sheet |
| Errors | Logged by Tern | `error` event to the program |
| Lifetime | Until the plugin reloads or is removed | With the surface, replayed into scrollback and snapshots |

A plugin never sends `s`: its views reach the window as surfaces Tern makes
for it, and its styling goes through manifest `styles` and `tern.css`.

## The cascade

Tern orders author rules by:

1. `!important` over normal declarations.
2. Specificity (ids, then classes, attributes and pseudo-classes, then tags).
3. Sheet order: a later sheet beats an earlier one at equal specificity.
4. Place in the sheet: a later rule wins.

An element's inline style comes after every sheet's normal rules, and only a
sheet's `!important` declaration beats it. The view writes inline style for
the common layout props (`grow`, `shrink`, `basis`, `min`, `max`) and for the
regions' zoom and grid variables, so restyling those from a sheet needs
`!important`.

Sheet order in a Tern window:

1. The kit's sheets (`theme.css`, `highlight.css`, `motion.css` and the rest),
   then the terminal view's `termview.css`.
2. The surface sheets, in this order: `surface.css`,
   `surface-content.css`, `surface-data.css`, `surface-list.css`,
   `surface-input.css`, `surface-lens.css`, `surface-el.css`, then omp's
   `omp.css`, `omp-pickers.css`, `omp-prefs.css`, `omp-transcript.css`,
   `omp-tools.css`, `omp-composer.css`, `omp-panels.css`, `omp-apps.css`,
   `omp-chat-reader.css`, `omp-chat-spine.css`, `omp-chat-console.css`.
3. Tern's own window sheets (tabs, panes, settings), then the file editor's.
4. Plugin sheets and program sheets, each placed last the first time its name
   is installed.

Replacing a sheet by name keeps its place in the cascade. A plugin reload
removes every `plugin:local:*` sheet and installs them again (manifest styles
first, then `tern.css` sheets), so order between plugins can shift. Don't
depend on it: win with specificity instead.

Because your sheet comes after Tern's, a rule of equal specificity wins. Most
of Tern's rules are one or two classes (`.sf-badge`, `.sf-card.inset >
.sf-card-body`), so a selector that starts with your block's region,
`.sf-main[data-surface='plugin.<p>.<b>']`, already outranks them.

## The DOM model

A view is three layers of elements.

```html
<!-- a region: one per main, dock and layer -->
<div class="sf-region sf-main sf-chat-reader sf-h-annotated"
	data-scope="sf3" data-surface="plugin.todo.list" data-role="todo.main">
	<!-- a node element: one per node -->
	<div class="sf sf-card" data-id="n4" data-role="todo.group" data-tone="accent">
		<!-- inner parts: the kind's own structure -->
		<div class="sf-card-head">…</div>
		<div class="sf-card-body">
			<div class="sf sf-row" data-id="n5">…</div>
		</div>
	</div>
</div>
```

**Regions.** Every surface has `.sf-region.sf-main`, `.sf-region.sf-dock`
and `.sf-region.sf-layer`. In a plugin block, `main` fills the pane and
scrolls itself, `dock` sits under it, and `layer` is an absolutely placed,
pointer-transparent layer for overlays (`overlay`, `toast`, pickers). A
region's root node is drawn as its children: its `role` lands on the region
element as `data-role`, and its own element is not drawn.

**Node elements.** Every node is `<tag class="sf sf-<kind>" data-id="<id>">`,
plus the common attributes below. The tag depends on the kind (`div`, `span`,
`button`, or the HTML tag of an `el`).

**Inner parts.** Each kind builds its own structure inside its element
(`.sf-card-head`, `.sf-tbl-c`, `.sf-ck-item`). Those classes are listed on
each element page and are Tern's implementation: they may change between
versions.

A lens view is one node drawn inside the terminal's command block,
`.sf-block[data-role='lens.plugin.<plugin>.<lens>']`. That block's surface
is output, not a screen, so its regions take no chat skin.

## Stable hooks

Target these. They are part of the protocol
([Stylesheets](../protocol/theme.md#stylesheets)) and stay put across versions.

| Hook | On | Set from |
| --- | --- | --- |
| `.sf-main`, `.sf-dock`, `.sf-layer` (with `.sf-region`) | Region elements | Always |
| `[data-surface='<role>']` | Region elements | The surface's role: `plugin.<plugin>.<block>` for a plugin block |
| `.sf-<kind>` (with `.sf`) | Every node element | The node's kind: `.sf-card`, `.sf-table`, `.sf-badge` |
| `[data-id='<id>']` | Every node element | The node's id (generated unless you set one) |
| `[data-role='<role>']` | Node element, or the region for a region root | The node's `role` prop |
| `[data-tone='<tone>']` | Node element | The node's `tone` prop |
| `[data-mark='<mark>']` | Node element | The node's `mark` prop |
| `[data-href='<target>']` | Node element | The node's `href` prop; `[data-href^='http']` tells URLs from paths |
| `[title]` | Node element | The node's `title` prop (also the tooltip). A few kinds read `title` as content instead (`tool`'s verb, `picker`'s heading); see their pages |
| `[aria-label]` | Node element | The node's `aria` prop |
| `el` tags and classes | `el` nodes | The `el` node's `tag` and `class` props ([el](../elements/el.md)) |
| `.sf-t-<token>` | Spans | A span's `s` tokens ([below](#span-token-classes)) |
| `.sf-block[data-role]`, `[data-state]`, `[data-view]`, `.failed` | Lens blocks | The lens id, the command's state, the shown view and the exit ([Lens blocks](#lens-blocks)) |

`data-role` and `data-surface` differ: the block's kind is on the regions as
`data-surface`; `data-role` belongs to nodes and carries their `role` props.

## State classes and attributes

The view toggles these as things change.
Sheets can read them; don't set them.

### On regions

| Class | Meaning |
| --- | --- |
| `.sf-region` | Any of the three regions. Sets the terminal font, size and line height and a neutral `--tc`. |
| `.sf-main` / `.sf-dock` / `.sf-layer` | Which region. |
| `.sf-chat-reader` / `.sf-chat-spine` / `.sf-chat-console` | Tern's Chat style setting. Inline and screen surfaces (omp sessions, plugin blocks); flow output and lens blocks take none. See [Chat skins](#chat-skins). |
| `.sf-still` | Reduce Motion is on: loops stop, shimmers go plain, indeterminate bars hold still. |
| `.sf-paused` | The pane is hidden: loops pause and resume where they were. |
| `.sf-unfocused` | The pane isn't the one being typed in. omp's composer folds to one row. |
| `.sf-h-annotated` | Markdown headings stay body size with a dim `#` marker (Tern's Markdown headings setting off, the default). |
| `.sf-covered` | On `main` and `dock` while a picker, modal or full overlay sits in `layer`: their animations pause under the dim. |
| `.sf-pal` | The program's palette is active ("Use program colors"): `--sf-p-<token>` variables are set on the region. |
| `data-scope="sf<N>"` | The view's scope token for program sheets. |
| `data-surface` | The surface role. |
| `data-role` | The region root node's `role`. |

The view also sets inline variables on each region: `--sf-fs`, `--sf-lh`,
`--sf-cw` (the terminal font size, line height and cell width), `--sf-zoom`
and the CSS `zoom` that scales a 13px design to the terminal font, plus the
program palette's variables while `.sf-pal` is on. See
[CSS Variables](variables.md).

### On node elements

| Class or attribute | Meaning |
| --- | --- |
| `.sf` | Every node element. |
| `.sf-hidden` | The node's `hidden` prop is true. `display: none !important`. |
| `.sf-void` | A `col` or `row` with nothing visible to show (every child hidden or void, and it doesn't grow). Takes no room and no gap. |
| `.sf-clip` | The node has a `max.h` bound: `overflow: hidden`, so content past it is cut. |
| `.sf-act` | The node has a `click` or `dblclick` action: an arrow cursor, even over text. |
| `.sf-back` | A block scrolled back into a virtualized `main`: its arrival animations start finished. |
| `.sf-hit` | The node holding Find's current match, when the match can't be boxed in text. |
| Kind state classes | Per kind: `.collapsed`, `.collapsible`, `.on`, `.st-<status>`, `.fresh`, `.done`, … Listed on each element page. |

### Decorations

Tern adds a few elements that are not nodes. All but the spacers carry
`.sf-deco`, so `:not(.sf-deco):not(.sf-pad)` skips them.

| Element | What |
| --- | --- |
| `div.sf-pad[aria-hidden]` | Spacers in a virtualized `main`, standing in for blocks above and below the window. No `.sf-deco`. |
| `div.sf-deco.sf-find > div.sf-find-mark` | Find's highlight boxes over the current match. |
| `div.sf-deco.sf-work-head` | The head of a folded run of work in `main` (Tern's fold-work setting). |
| `span.sf-deco.sf-thought-sum` | The summary on the first head of a chain of thoughts in omp's transcript. |
| `.sf-deco.sf-caption` (`.sf-drafted`, `.sf-caption-name`, `.sf-caption-draft`) | The folded composer's caption in an unfocused omp pane. |
| `div.sf-deco.sf-brand` | omp's app mark. |

## Tones

A node's `tone` sets `data-tone` and, through it, `--tc`: the tone color every
kind's chrome reads (`surface.css`). Restyle with `var(--tc)` and your rule
follows whatever tone the node has.

| Tone | `--tc` |
| --- | --- |
| `neutral` | `var(--sf-neutral)` |
| `accent` | `var(--sf-accent, var(--accent))` |
| `info` | `var(--sf-info)` |
| `success` | `var(--sf-ok)` (Tern's `--ok`) |
| `warning` | `var(--sf-warn)` (Tern's `--warn`) |
| `error` | `var(--sf-bad)` (Tern's `--bad`) |
| `pending` | `var(--live)` |
| `muted` | `var(--sf-muted)` |
| `user` | `var(--sf-user)` (Tern's `--ink-pen`) |

Any other `tone` value is dropped (no `data-tone`). With no tone, a node
inherits `--tc` from its parent, and the region sets it to `--sf-neutral`;
a `card` without a tone resets it to `--sf-neutral` instead of inheriting.
Kinds tint with it as `rgb(from var(--tc) r g b/10%)`; a `card` also takes a
program palette fill `--sf-tint-<tone>` when one is set. The values of
`--sf-ok`, `--sf-info` and the rest are on [CSS Variables](variables.md).

## Span token classes

A span's `s` is a space-separated list of tokens. Each known semantic token
becomes a class `.sf-t-<token>` on the span.
Unknown tokens are dropped.

| Token | Class | Effect |
| --- | --- | --- |
| `muted` | `.sf-t-muted` | `color: var(--sf-c-muted)` |
| `dim` | `.sf-t-dim` | `color: var(--sf-c-dim)` |
| `strong` | `.sf-t-strong` | Bold |
| `em` | `.sf-t-em` | Italic |
| `accent` | `.sf-t-accent` | `color: var(--sf-c-accent)` |
| `success` | `.sf-t-success` | `color: var(--sf-c-success)` |
| `warning` | `.sf-t-warning` | `color: var(--sf-c-warning)` |
| `error` | `.sf-t-error` | `color: var(--sf-c-error)` |
| `info` | `.sf-t-info` | `color: var(--sf-c-info)` |
| `code` | `.sf-t-code` | `color: var(--sf-c-code)` (the text color), on a chip background with a hairline ring |
| `mono` | `.sf-t-mono` | Tabular figures (views already use the terminal's monospace face) |
| `path` | `.sf-t-path` | `color: var(--sf-c-path)`; a `.dir` part inside is muted |
| `key` | `.sf-t-key` | `color: var(--sf-c-key)`, keycap look |
| `link` | `.sf-t-link` | `color: var(--sf-c-link)` |
| `num` | `.sf-t-num` | `color: var(--sf-c-num)`, tabular figures |
| `ins` | `.sf-t-ins` | `color: var(--sf-c-ins)` |
| `del` | `.sf-t-del` | `color: var(--sf-c-del)`, struck through |
| `mark` | `.sf-t-mark` | Highlighted, as a search match |
| `typo` | `.sf-t-typo` | Marked as a misspelling |
| `icon` | `.sf-t-icon` | An icon glyph, `aria-hidden`. `.gap` is added when the next text doesn't start with a space, and sets a margin after it |
| `hide` | `.sf-t-hide` | Hidden |

omp's theme tokens (`toolTitle`, `statusLineModel`, `syntaxString`, …) also
work in `s`: each maps to the nearest semantic token's class, and with
program colors on, its color comes from `--sf-p-<token>`. The full mapping is
in [Text](../elements/text.md), which also covers spans.

## Chat skins

Tern's Chat style setting (Reader, the default; Spine; Console) puts
`.sf-chat-reader`, `.sf-chat-spine` or `.sf-chat-console` on the regions of
every inline and screen surface in the pane, plugin blocks included. Flow
output and lens blocks take none. The `omp-chat-*.css` sheets draw each
skin. Most of their rules target omp roles (`[data-role^='omp.']`); a few
shape `main` itself:

| Skin | What it does to an inline surface's `main` (omp's transcript) |
| --- | --- |
| Reader | Centers `main`'s children on a 720px measure, 20px apart, with `24px 16px 0` padding. |
| Spine | One column at most 920px wide, centered, with a rail drawn by `main::before`. |
| Console | One column at most 1040px wide, centered, with a 3-cell left gutter, children 0.75 lines apart. |

A plugin block is a **screen** surface: its regions mount in the pane's
cover (`.tv-cover`), and every skin turns its measure off there, so `main`
spans the pane edge to edge with no rail or gutter. What still reaches it:

| Skin | What reaches a plugin block's `main` |
| --- | --- |
| Reader, Spine | `padding: 6px 0` and `gap: var(--sf-block-gap)`, as with no skin |
| Console | `gap` of 0.75 lines between `main`'s children, tabular figures |

Those cover rules are four classes and attributes deep
(`.tv-cover .sf-chat-reader.sf-main:not([data-surface='omp.rewind'])`), so
`.sf-main[data-surface='…']` loses to them on `padding` and `gap`. Set the
spacing of your own `main` with `!important`:

```css
.sf-main[data-surface='plugin.todo.list'] {
	gap: 10px !important;
	padding: 8px 12px !important;
}
```

## Light and dark

Tern sets `data-theme='light'` or `data-theme='dark'` on the document root
for the shown theme. Two ways to follow it:

- `light-dark(<light>, <dark>)` in any color value, as Tern's own sheets do
  (`--sf-info: light-dark(#0e89a8, #35c7e6)`).
- `[data-theme='dark'] <selector>` for anything that isn't a color.

`@media (prefers-color-scheme: …)` is **not** supported: the parser rejects
the feature and drops the rule. Better still,
color with Tern's variables (`--t1`…`--t4`, `--accent`, `--ok`, `--sf-c-*`,
`--tc`), which already switch. See [CSS Variables](variables.md).

## Reduced motion and hidden panes

Tern runs all motion and honors Reduce Motion two ways:

- `.sf-still` on the regions while the setting is on. Tern's sheets stop
  spinners, shimmers, pulses and effort arcs under it.
- `@media (prefers-reduced-motion: reduce)`, which Tern supports.

`.sf-paused` (a hidden pane) and `.sf-covered` (a sheet over the pane) pause
animations without resetting them. If you add your own animation, stop it
under `.sf-still` and pause it under `.sf-paused`:

```css
.sf-main[data-surface='plugin.build.status'] [data-role='build.live'] {
	animation: build-pulse 1.2s ease-in-out infinite;
}
.sf-still [data-role='build.live'] {
	animation: none;
}
.sf-paused [data-role='build.live'] {
	animation-play-state: paused;
}
@keyframes build-pulse {
	from { opacity: 1; }
	50% { opacity: 0.5; }
	to { opacity: 1; }
}
```

## Lens blocks

A lens view sits in the command block:

```html
<div class="sf sf-block failed" data-id="…"
	data-role="lens.plugin.disk.du" data-state="done" data-view="native">
	<div class="sf-block-bar">
		<span class="sf-block-lens"><span class="sf-block-ic"></span><span class="lbl">du</span></span>
		<div class="sf-block-seg"><button class="sf-block-opt on">Native</button><button class="sf-block-opt">Raw</button></div>
		<button class="sf-block-copy">Copy</button>
	</div>
	<div class="sf-block-body"><!-- your lens view's node --></div>
	<div class="sf-block-foot"><span class="sf-badge" data-tone="error">exit 1</span><span class="sf-block-took">2.3s</span></div>
</div>
```

The toolbar shows on hover or keyboard focus. The foot shows only for a
non-zero exit or a run longer than a second.

| Target | Selector |
| --- | --- |
| Your lens's blocks | `.sf-block[data-role='lens.plugin.<plugin>.<lens>']` |
| While the command runs | `[data-state='running']` |
| After it finishes | `[data-state='done']` |
| After a non-zero exit | `.failed` |
| Showing your view, or the raw output | `[data-view='native']`, `[data-view='raw']` |
| The left edge | `::before` |
| Toolbar, body, foot | `.sf-block-bar`, `.sf-block-body`, `.sf-block-foot` (inner, may change) |

## Best practices

- **Give nodes roles under your plugin id** (`role = "todo.row"`) and style
  by `[data-role]`. Role names are yours and won't collide with Tern's or
  another plugin's.
- **Scope every rule.** Your sheet is global. Start selectors with
  `.sf-main[data-surface='plugin.<p>.<b>']`, a lens block's `data-role`, or
  one of your roles. A bare `.sf-card { … }` restyles every card in every
  pane, omp's included.
- **Color with variables**: `--tc`, `--t1`…`--t4`, `--accent`,
  `--accent-fill` (for white text on accent), `--ok`, `--warn`, `--bad`,
  `--sf-c-<token>`. They follow light, dark and the user's theme.
- **Prefer `tone` and span tokens over CSS** when they say what you mean.
  They carry meaning the theme and the program palette can recolor.
- **Avoid inner classes.** `.sf-card-head`, `.sf-tbl-c`, `.sf-ck-item` and
  the like are Tern's structure and can change. When you must use one, anchor
  it to a stable hook and expect to revisit it.
- **Don't fight the layout props.** `grow`, `basis`, `min` and `max` are
  inline style. Set them as props, not in CSS.
- **Use px for sizes.** The view zooms each region by font size / 13, so plain
  px follow the terminal font.

## Recipes

### Restyle one block's cards

```lua
local ui = tern.ui

local card = ui.node("card", { head = "Today", role = "todo.day" }, {
	ui.node("text", { spans = { "3 open" } }),
})
```

```css
.sf-main[data-surface='plugin.todo.list'] .sf-card[data-role='todo.day'] {
	border-radius: 10px;
	background: rgb(from var(--tc) r g b/6%);
	box-shadow: inset 0 0 0 1px var(--l2);
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-index-card.light.png" srcset="../figures/styles-index-card.light.png 2x" alt="Two cards side by side: Tern's default card on the left, and the todo.day card on the right with rounder corners, a faint fill and a hairline ring">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-index-card.dark.png" srcset="../figures/styles-index-card.dark.png 2x" alt="Two cards side by side: Tern's default card on the left, and the todo.day card on the right with rounder corners, a faint fill and a hairline ring">
<figcaption>Left, a card without the role; right, the <code>todo.day</code> card.</figcaption>
</figure>

### Compact tables

```css
.sf-block[data-role='lens.plugin.disk.du'] .sf-table {
	font-variant-numeric: tabular-nums;
}
/* .sf-tbl-h and .sf-tbl-c are inner parts: anchored to the lens, may change */
.sf-block[data-role='lens.plugin.disk.du'] .sf-tbl-h {
	height: 20px;
	line-height: 20px;
}
.sf-block[data-role='lens.plugin.disk.du'] .sf-tbl-c {
	padding-top: 0;
	padding-bottom: 0;
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-index-table.light.png" srcset="../figures/styles-index-table.light.png 2x" alt="Two lens blocks with the same table: the default rows on the left, tighter header and rows in the disk.du block on the right">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-index-table.dark.png" srcset="../figures/styles-index-table.dark.png 2x" alt="Two lens blocks with the same table: the default rows on the left, tighter header and rows in the disk.du block on the right">
<figcaption>Left, another lens's table; right, the <code>disk.du</code> lens's.</figcaption>
</figure>

### Change a tone's color in your views

`--tc` is set by `[data-tone]` on the same element, so override it there,
on your own nodes:

```css
.sf-main[data-surface='plugin.ci.runs'] [data-role^='ci.'][data-tone='pending'] {
	--tc: light-dark(#0f8a8a, #3fd0c9);
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-index-tone.light.png" srcset="../figures/styles-index-tone.light.png 2x" alt="A pending badge and progress bar in Tern's purple on the left, and the same pair in teal on the right">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-index-tone.dark.png" srcset="../figures/styles-index-tone.dark.png 2x" alt="A pending badge and progress bar in Tern's purple on the left, and the same pair in teal on the right">
<figcaption>Left, <code>pending</code> nodes without a <code>ci.</code> role; right, with one.</figcaption>
</figure>

### A custom badge look

```lua
local ui = tern.ui

local badge = ui.node("badge", { text = "beta", tone = "accent", role = "todo.flag" })
```

```css
.sf-badge[data-role='todo.flag'] {
	height: 16px;
	padding: 0 5px;
	border-radius: 4px;
	font-family: var(--mono);
	text-transform: uppercase;
	color: white;
	background: var(--accent-fill);
	box-shadow: none;
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-index-badge.light.png" srcset="../figures/styles-index-badge.light.png 2x" alt="An accent badge reading beta, and the todo.flag badge: a square, filled blue tag reading BETA in white">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-index-badge.dark.png" srcset="../figures/styles-index-badge.dark.png 2x" alt="An accent badge reading beta, and the todo.flag badge: a square, filled blue tag reading BETA in white">
<figcaption>Left, <code>ui.badge("beta", "accent")</code>; right, the <code>todo.flag</code> badge.</figcaption>
</figure>

### Dim finished checklist items

A `checklist` item row carries `.st-<status>` (`pending`, `active`, `done`,
`dropped`, `blocked`); see [Work](../elements/work.md).

```css
.sf-checklist[data-role='todo.steps'] .sf-ck-item.st-done {
	opacity: 0.5;
}
```

For your own rows (`list`/`item`), mark them yourself: set `mark = "done"`
and target `[data-mark='done']`, which is stable.

```css
.sf-main[data-surface='plugin.todo.list'] .sf-item[data-mark='done'] .sf-t-del {
	opacity: 0.6;
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-index-done.light.png" srcset="../figures/styles-index-done.light.png 2x" alt="Two checklists and two struck list items: on the right, the done items of the todo.steps checklist and the marked item are faded">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-index-done.dark.png" srcset="../figures/styles-index-done.dark.png 2x" alt="Two checklists and two struck list items: on the right, the done items of the todo.steps checklist and the marked item are faded">
<figcaption>Left, Tern's defaults; right, the <code>todo.steps</code> checklist and an item with <code>mark = "done"</code>.</figcaption>
</figure>

### Style a lens block by state

```css
.sf-block[data-role='lens.plugin.build.make'][data-state='running']::before {
	background: var(--accent);
}
.sf-block[data-role='lens.plugin.build.make'].failed .sf-block-body {
	background: rgb(from var(--bad) r g b/6%);
	border-radius: 6px;
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-index-lens.light.png" srcset="../figures/styles-index-lens.light.png 2x" alt="Two make blocks: a running one with an accent left edge, and a failed one whose output sits on a faint red fill above an exit 2 badge">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-index-lens.dark.png" srcset="../figures/styles-index-lens.dark.png 2x" alt="Two make blocks: a running one with an accent left edge, and a failed one whose output sits on a faint red fill above an exit 2 badge">
<figcaption>A running block, then one that exited 2 after 4.2 s.</figcaption>
</figure>

### Toggle a sheet at run time

An `item` row is at least a line plus 6px tall (`min-height`), with no
vertical padding; the compact sheet drops the extra 6px.

```lua
local compact = false

tern.command({
	id = "compact",
	title = "Toggle compact rows",
	run = function(_cx)
		compact = not compact
		tern.css("density", if compact
			then ".sf-main[data-surface='plugin.todo.list'] .sf-item { min-height: var(--sf-lh); }"
			else "")
	end,
})
```

## Debugging styles

Run a window with a control endpoint and ask it
([Debugging](../guides/debugging.md#driving-a-window-from-a-script)):

```sh
tern --control /tmp/tern-ctl.sock ~/src/my-plugin &
tern ctl --control /tmp/tern-ctl.sock css
tern ctl --control /tmp/tern-ctl.sock tree "[data-surface='plugin.todo.list'] [data-role='todo.day']"
```

- `css` lists the installed sheets in cascade order. Look for
  `plugin:local:<id>:styles` and your `tern.css` names, and check yours come
  after the surface sheets.
- `tree SEL` shows the visible elements a selector matches, with their
  classes and attributes. No match means the selector is wrong (often
  `data-role` where `data-surface` is meant).
- Parse errors are in the log as `plugin style sheet has errors`, with the
  sheet's name ([Log files](../guides/debugging.md#log-files)).

When a rule matches but loses, compare specificity with Tern's rule for the
same element (the element page's selectors),
and add one stable hook to yours.
