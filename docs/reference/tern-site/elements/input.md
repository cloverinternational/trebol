# Inputs

Two kinds draw a text field whose text your program owns: `editor` for
multi-line text (a composer, a message box, a code draft) and `input` for one
line (a filter, a form field). Tern draws the text, the caret, the selection
and decorations; it never edits the text itself. Keys reach your program, and
your program answers with new `text` and `cursor` props.

| Kind | Builder | Draws |
| --- | --- | --- |
| [`editor`](#editor) | `tern.ui.node("editor", …)` | A multi-line field: soft wrap, optional line cap, code highlighting |
| [`input`](#input) | `tern.ui.node("input", …)` | A one-line field that scrolls sideways |

Neither kind has a builder of its own; use [`tern.ui.node`](../reference/ui.md#node).
`tern.canvas` rejects both: a canvas node of kind `editor` or `input` (or
`image`) fails with `canvas kind "editor" is not supported`. Use them in a
block's view.

## The program owns the text

A field is a picture of your state. Nothing typed changes it until your view
sends a new `text`:

1. The user presses a key while your block's pane has focus. The key goes to
   your block's `key` handler (see [Blocks](../guides/blocks.md#keys-and-paste)),
   never to the field as a DOM event.
2. Your handler changes your state (inserts the character, moves the
   cursor) and returns.
3. Your next `view` returns the field with the new `text` and `cursor`; Tern
   redraws the runs that changed and keeps the caret in view.

Offsets (`cursor`, `anchor`, `decor` bounds) are **UTF-16 code units**, as
in a JavaScript string. In Luau, where strings are bytes, convert: ASCII text
has the same offsets either way; for other text count UTF-16 units
(`utf8.codepoint` above `0xFFFF` counts 2). An offset inside a surrogate pair
rounds down to the character it splits; an offset past the end clamps to the
end.

## Focus and the caret

The caret is one 2 px beam (`span.sf-caret`) that takes no room. It shows on
every field, dimmed (`opacity: 0.3`), except a `readonly` one, and blinks at
full strength only on the field that has the surface's **focus** (a focused
`readonly` field shows it too). Focus is the TSP `focus` frame op
(`["focus", id]` or `["focus", null]`); it names the node that owns the caret
and the IME. The view diff never sends it, so a block sets it with a raw op:

```lua
cx:frame({ { "focus", "main.query" } })
```

`id` is the node's id in the view (`main.query` for a child keyed `query` of
`main`; see [Blocks](../guides/blocks.md)). Raw ops bypass the diff, and the
focus stays until another `focus` op changes it. Give the field a stable `key`
so its id doesn't move. On a focused field the node gets `.focused` (an accent
ring) and the caret blinks; it holds steady under reduced motion, in a hidden
pane and in a pane not typed in (`.sf-still`, `.sf-paused`, `.sf-unfocused`
on an ancestor).

Focus only decides which field shows the live caret. Keys still go to your
`key` handler whichever field is focused; route them by your own state (keep
the focused field's key in state next to its text).

A primary click in a field that isn't the focus (and isn't `readonly`) sends a
`focus` event instead of placing a caret:

```lua
ev = { ev = "focus", id = "main.query" }
```

Answer it by moving your own focus there and sending the `focus` op, or ignore
it (a modal overlay may keep the keys). A click in the focused field places
the caret only when native editing is on (below); for a plugin block it does
nothing.

## Native editing, `edit` and `undo`

TSP lets the terminal keep a selection of its own over the drawn text (⇧ with
arrows, ⌘A, ⌘C, drag), apply edits to it and send them as `edit` events
(`{ev = "edit", id, from, to, text, cursor, len}`, replace `from..to` with
`text`, caret at `cursor`, `len` the text length it was computed against), and
take ⌃Z as an `undo` event (`{ev = "undo", id}`). The spell checker's
context menu over a `typo` decoration also answers with an `edit` event.

Tern turns this on only for a program whose `hello` lists the `edit` feature
(and `undo` for ⌃Z), only on a field without `mode` and not `readonly`, and
only while the user's Settings › Terminal › Native composer editing is on.
**Plugin blocks advertise no features** (their hello sends `features: []`),
so in a block:

- every key, including ⇧-arrows, ⌘A and ⌃Z, reaches your `key` handler;
- there is no native selection: draw one yourself with `anchor`;
- no `edit` or `undo` events arrive, and the `typo` context menu doesn't
  offer guesses.

A block's `event` handler still lists `edit` and `undo` among the events it
hears; a block just never receives them
today. `focus` does arrive.

## IME

Tern composes IME input in its own hidden text area and places the
composition window at the focused field's caret (the caret element is what
the IME is placed against), then commits the composed text to the program as
typed text. The field must be the `focus` for the composition to appear at its
caret. A block's `key` handler gets the committed text like typing: one key per
character, each with its `text`.

## `editor`

A multi-line field. Text soft-wraps (`white-space: pre-wrap`, breaking
anywhere), so a long line never scrolls sideways; `nowrap` clips a long line
instead, like a terminal row. Without `maxLines` it grows with its text; with
`maxLines = N` it grows to N lines and then scrolls inside itself, keeping the
caret in view after each frame; a `topline` puts the scroll in the program's
hands (that line at the top, the caret no longer moving it). `gutter` spans
(line numbers, signs) draw at each line's start and `virt` spans (inlay hints,
diagnostics) at each line's end; both are laid out with the text but are not
part of it, so `cursor`, `decor` and native editing never see them. With
`lang`, the text is code: Tern's highlighter colors it in the background (an
edited line keeps its old colors until the new ones land, so typing never
flashes plain) and the field adds `.code`. Every surface already draws in the
mono face, so `lang` changes the colors, not the font.

**Build it:** `tern.ui.node("editor", { text = …, cursor = … })`.

For a program-owned code viewport, send the whole text and index `gutter`
and `virt` by logical line (each entry is a string or an array of spans):

```lua
tern.ui.node("editor", {
	text = "local answer = 42\nprint(answer)\n",
	cursor = 6,
	lang = "lua",
	highlight = false,
	decor = { { from = 6, to = 12, s = "syntaxVariable" } },
	gutter = { "1 │ ", "2 │ ", "3 │ " },
	virt = { "  : number", "", "" },
	nowrap = true,
	maxLines = 2,
	topline = 1,
})
```

`topline` is zero-based; convert a one-based buffer line number before
sending it. Omitting `topline` with `followCursor = false` preserves the
existing scroll without pinning a particular line. Colors in `decor`,
`gutter` and `virt` use the same span tokens and
[program palette](../protocol/theme.md#program-palette) as ordinary text.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `text` | string | `""` | The text. Primary text: a diff that only appends sends an append op |
| `cursor` | number (UTF-16) | end of text | Caret position. Clamped to the text |
| `anchor` | number (UTF-16) or nil | nil | Selection anchor; the selection is `anchor`..`cursor` in either order; none when equal or nil |
| `decor` | `{ {from, to, s, fx?} }` | `{}` | Decorations: UTF-16 range `from`..`to` styled with span tokens `s` (space-separated, see [Text](text.md)); `fx` a span effect (`shimmer`, `pulse`). Empty ranges are ignored; overlapping entries combine tokens in order. `typo` marks a misspelling |
| `ghost` | string | `""` | Inline completion suffix drawn dim right after the caret |
| `placeholder` | string | `""` | Dim text shown while `text` is empty (and no `ghost`); also `aria-placeholder` |
| `prompt` | spans | none | Spans before the first line (`> `, a shell prompt) |
| `mode` | string | none | A vim mode label: shows it in a mode chip (`title` `Mode: <label>`) and sets `data-mode` (lowercased) on the field and the chip; turns native editing off. The chip is a neutral pill; an `insert` chip is tinted accent. The caret keeps its beam in every mode |
| `lang` | string | none | The text is code in this language: highlighted unless `highlight` is false, `.code` |
| `highlight` | boolean | `true` | Set false to use your program's `decor` colors without Tern's syntax highlighter, keeping `lang`'s code presentation |
| `readonly` | boolean | `false` | Not editable: hides the caret unless focused, default cursor, `aria-readonly`, no `focus` event on click, no native editing, no `send` |
| `sendable` | boolean | `false` | The owner accepts an atomic `send` into this field ([Sending](../protocol/input.md#native-editing), with the `send` hello feature). Tern drops a `send` to a field that isn't `sendable: true` or is `readonly`, `disabled` or `hidden`. Plugin blocks don't advertise `send`, so it has no effect from a block |
| `maxLines` | number | none | Cap the height at N lines (`calc(N * var(--sf-lh))`) and scroll inside; adds `.capped`. `0` or absent: no cap |
| `nowrap` | boolean | `false` | A long line clips like a terminal row instead of soft-wrapping (`white-space: pre`); adds `.nowrap`. A capped field still scrolls vertically |
| `topline` | number (0-based line) | none | The program owns the scroll: that line sits at the top and the caret no longer scrolls the field. Absent: Tern keeps the caret in view (with `maxLines`) |
| `followCursor` | boolean | `true` | Set false to leave scrolling alone when the caret moves. A supplied `topline` is authoritative regardless of this flag |
| `gutter` | `{ TspText }` (one per line) | `{}` | Spans in a shared, nonwrapping gutter column aligned to each logical line's first visual row, even when text wraps (`span.sf-ed-gutter`, `aria-hidden`). The widest entry determines the column width. Not part of `text`; missing entries draw nothing |
| `virt` | `{ TspText }` (one per line) | `{}` | End-of-line spans drawn at each line's end (`span.sf-ed-virt`), for inlay hints and diagnostics; the last line's entry draws too. Not part of `text`; missing entries draw nothing |
| `aria` | string | `"Message"` | Accessible name (common prop) |

Common props (`role`, `tone`, `hidden`, `grow`, `min`, `max`, `actions`, …)
work as on any node; see [Elements](index.md).

**Children:** none (ignored).

**Events:** `focus` (click in an unfocused, editable field). `edit` and `undo`
only for programs with those hello features (not plugin blocks). `actions`
work as on any node.

**Styling:**

```html
<div class="sf sf-editor focused code" data-id="main.draft" role="textbox"
     aria-multiline="true" data-mode="insert">
	<div class="sf-ed-scroll">
		<div class="sf-ed-text">
			<span class="sf-ed-prompt">…</span>
			<span class="sf-ed-gutter" aria-hidden="true">12 </span>
			plain run
			<span class="sf-ed-sel"><span class="tk-keyword">sel</span></span>
			<span class="sf-t-accent">@file</span>
			<span class="sf-caret"></span>
			<span class="sf-ed-ghost">suggested suffix</span>
			rest of the text
			<span class="sf-ed-virt" aria-hidden="true">◀ hint</span>
		</div>
	</div>
	<span class="sf-ed-mode on" data-mode="insert" title="Mode: INSERT">INSERT</span>
</div>
```

`span.sf-ed-ph` replaces the ghost when the text is empty and there is no
ghost. While an IME composes in the focused field, its marked text draws at
the caret in `span.sf-ed-preedit` (underlined) in place of both, the caret at
the input method's caret inside it; the commit reaches you as typed text.

| Target | Selector |
| --- | --- |
| The node | `.sf-editor` |
| Has the focus | `.sf-editor.focused` |
| Read-only | `.sf-editor.readonly` |
| Empty text | `.sf-editor.empty` |
| Code (`lang`) | `.sf-editor.code` |
| Height capped (`maxLines`) | `.sf-editor.capped` |
| Never wraps (`nowrap`) | `.sf-editor.nowrap` |
| A native selection showing | `.sf-editor.selecting` (never in a plugin block) |
| Vim mode | `.sf-editor[data-mode='normal']` |
| Scroller | `.sf-ed-scroll` (inner, may change) |
| Text flow | `.sf-ed-text` (inner, may change) |
| Prompt | `.sf-ed-prompt` (inner, may change) |
| Gutter run | `.sf-ed-gutter` (inner, may change) |
| End-of-line virtual text | `.sf-ed-virt` (inner, may change) |
| Selected run | `.sf-ed-sel` (inner, may change) |
| Decoration run | `.sf-t-<token>` (stable token classes, see [Text](text.md)) |
| Highlighted code run | `.tk-<token>` (kit highlighter) |
| Caret | `.sf-caret` (inner, may change) |
| Ghost suffix | `.sf-ed-ghost` (inner, may change) |
| Placeholder | `.sf-ed-ph` (inner, may change) |
| IME composition | `.sf-ed-preedit` (inner, may change) |
| Mode chip | `.sf-ed-mode.on`, `.sf-ed-mode[data-mode='insert']` (inner, may change) |

Stable hooks are `.sf-editor`, `[data-id]`, `[data-role]`, `[data-tone]` and
the region's `[data-surface]`; the inner classes above are Tern's structure.

Look: padding `6px 10px`, `--r-ctl` corners, a `--l1` hairline top, an accent
ring while focused. Text color `var(--tv-fg, var(--t1))`; the caret is
`var(--tv-cur, var(--accent))`: in a pane, the terminal theme's cursor color,
not the accent; selection is the accent at 20 % (light) / 34 % (dark); prompt
`--t3`; ghost and placeholder `--t4`. Line height is `--sf-lh` (see
[Variables](../styles/variables.md)). A `.code` field looks like any other
field: the colors change, the box doesn't.

omp's composer (an editor inside an `omp.editor*` role) draws its Markdown
inline (`.markdown` with `md-*` spans) and has its own vim look: the `insert`
chip hidden, `normal` tinted accent, `visual` warning, and a block caret in
`normal` and `visual`. Those looks apply only there, never in a plugin view.

```lua
local ui = tern.ui

local function view(state)
	return {
		main = ui.col({ ui.text(state.sent or "") }),
		dock = ui.col({
			ui.node("editor", {
				key = "draft",
				text = state.draft,
				cursor = state.cursor,
				placeholder = "Write a note, Enter to save",
				prompt = { ui.span("› ", "muted") },
				maxLines = 6,
			}),
		}),
	}
end

local function key(state, k, cx)
	if k.name == "enter" and not k.shift then
		state.sent, state.draft, state.cursor = state.draft, "", 0
	elseif k.name == "backspace" and state.cursor > 0 then
		state.draft = state.draft:sub(1, state.cursor - 1) .. state.draft:sub(state.cursor + 1)
		state.cursor -= 1
	elseif k.name == "left" then
		state.cursor = math.max(0, state.cursor - 1)
	elseif k.name == "right" then
		state.cursor = math.min(#state.draft, state.cursor + 1)
	elseif k.text and not (k.ctrl or k.meta) then
		-- typed text, or a whole paste (name = "paste")
		state.draft = state.draft:sub(1, state.cursor) .. k.text .. state.draft:sub(state.cursor + 1)
		state.cursor += #k.text
	else
		return false
	end
end
```

Before the first key the field shows its prompt, the dimmed caret and the
placeholder:

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-input-placeholder.light.png" srcset="../figures/elements-input-placeholder.light.png 2x" alt="An empty editor: a dim › prompt, a dimmed caret and the placeholder Write a note, Enter to save in faint text">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-input-placeholder.dark.png" srcset="../figures/elements-input-placeholder.dark.png 2x" alt="An empty editor: a dim › prompt, a dimmed caret and the placeholder Write a note, Enter to save in faint text">
</figure>

This example treats offsets as bytes, which is right for ASCII text only.
Focus the field from any handler that has `cx` once the field has been drawn,
for example when a `focus` event arrives:

```lua
event = function(state, ev, cx)
	if ev.ev == "focus" then
		cx:frame({ { "focus", ev.id } })
	end
end
```

Focused, with text, a decoration and a completion suggested at the caret:

```lua
ui.node("editor", {
	key = "draft",
	text = "Ship the notes after @review",
	cursor = 28,
	ghost = " signs off",
	decor = { { from = 21, to = 28, s = "accent" } },
	placeholder = "Write a note, Enter to save",
	prompt = { ui.span("› ", "muted") },
	maxLines = 6,
})
-- and once: cx:frame({ { "focus", "dock.draft" } })
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-input-editor.light.png" srcset="../figures/elements-input-editor.light.png 2x" alt="A focused editor with an accent ring: the text Ship the notes after @review with @review in the accent color, a solid caret after it and the ghost suffix signs off in faint text">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-input-editor.dark.png" srcset="../figures/elements-input-editor.dark.png 2x" alt="A focused editor with an accent ring: the text Ship the notes after @review with @review in the accent color, a solid caret after it and the ghost suffix signs off in faint text">
<figcaption>The focus ring and full-strength caret come from the focus op, not from a prop.</figcaption>
</figure>

## `input`

A one-line field in a tinted well. It takes the same props and draws the same
DOM as `editor`, with these differences:

- The text never wraps (`white-space: pre`); the field scrolls sideways
  (scrollbar hidden) and keeps the caret in view.
- `maxLines` is ignored.
- `aria-multiline="false"`; the default accessible name is the
  `placeholder`, or `"Search"` without one.
- Height is one line plus 8 px (`calc(var(--sf-lh) + 8px)`), padding `0 8px`,
  `--l1` background; focused, the background clears and an accent ring
  shows.

**Build it:** `tern.ui.node("input", { text = …, cursor = … })`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `text`, `cursor`, `anchor`, `decor`, `ghost`, `placeholder`, `prompt`, `mode`, `lang`, `readonly`, `sendable` | as [`editor`](#editor) | | |
| `aria` | string | `placeholder` or `"Search"` | Accessible name |

An idle field next to the focused one, with a selection drawn from `anchor`:

```lua
ui.col({
	ui.node("input", {
		key = "filter",
		placeholder = "Filter",
		prompt = { ui.span("/", "muted") },
	}),
	ui.node("input", {
		key = "query",
		text = "deploy logs",
		cursor = 6,
		anchor = 0,
		placeholder = "Filter",
		prompt = { ui.span("/", "muted") },
	}),
})
-- focused with cx:frame({ { "focus", "main.query" } })
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-input-input.light.png" srcset="../figures/elements-input-input.light.png 2x" alt="Two input fields: an idle one in a tinted well showing a / prompt and the placeholder Filter, and a focused one with an accent ring, the word deploy selected and the caret after it">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-input-input.dark.png" srcset="../figures/elements-input-input.dark.png 2x" alt="Two input fields: an idle one in a tinted well showing a / prompt and the placeholder Filter, and a focused one with an accent ring, the word deploy selected and the caret after it">
</figure>

**Children:** none (ignored).

**Events:** as [`editor`](#editor).

**Styling:**

```html
<div class="sf sf-input focused" data-id="main.filter" role="textbox"
     aria-multiline="false" aria-placeholder="Filter">
	<div class="sf-ed-scroll">
		<div class="sf-ed-text">abc<span class="sf-caret"></span></div>
	</div>
	<span class="sf-ed-mode"></span>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-input` |
| States | `.sf-input.focused`, `.readonly`, `.empty`, `.code`, `.selecting`, `[data-mode]` |
| Parts | `.sf-ed-scroll`, `.sf-ed-text`, `.sf-ed-prompt`, `.sf-ed-sel`, `.sf-caret`, `.sf-ed-ghost`, `.sf-ed-ph`, `.sf-ed-preedit`, `.sf-ed-mode` (inner, may change) |

A filter field above a list, with the query's matches marked in the list:

```lua
local ui = tern.ui

local function view(state)
	return {
		main = ui.col({
			ui.node("input", {
				key = "filter",
				text = state.query,
				cursor = #state.query,
				placeholder = "Filter",
				prompt = { ui.span("/", "muted") },
			}),
			ui.node("list", { key = "rows", filter = state.query }, state.items),
		}),
	}
end
```

Restyle the field from your sheet:

```css
[data-surface^='plugin.notes.'] .sf-input {
	background: transparent;
	box-shadow: inset 0 -1px 0 var(--l2);
	border-radius: 0;
}
[data-surface^='plugin.notes.'] .sf-input.focused {
	box-shadow: inset 0 -2px 0 var(--accent);
}
[data-surface^='plugin.notes.'] .sf-input .sf-caret {
	background: var(--accent);
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-input-restyle.light.png" srcset="../figures/elements-input-restyle.light.png 2x" alt="The two filter fields restyled as bare underlined lines: the idle one with a hairline under it, the focused one with a 2 px accent underline and an accent caret">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-input-restyle.dark.png" srcset="../figures/elements-input-restyle.dark.png 2x" alt="The two filter fields restyled as bare underlined lines: the idle one with a hairline under it, the focused one with a 2 px accent underline and an accent caret">
</figure>

The first rule outranks Tern's `.sf-input.focused` (same specificity, later
sheet), so it also drops the focus ring; the `.focused` rule puts a focus
cue back.

See [Styling Views](../styles/index.md) for how sheets are scoped and
[Supported CSS](../styles/css.md) for what a rule may use.
