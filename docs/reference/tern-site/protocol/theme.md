# Palette, Stylesheets and Icons

A program can bring its own colors (`t`), its own CSS (`s`) and its own icon
glyphs. Each is optional: without them, Tern draws the surface in its own
theme.

## Program palette

Right after `o` and before the surface's first `f`, send your whole resolved
theme with the `t` verb (feature `program-palette`):

```json
{"sf":"s1","dark":{"accent":"#00b4ff","muted":"#9ca3b0","toolSuccessBg":"#0f2a1c"},"light":{…},
 "name":{"dark":"titanium","light":"light"}}
```

- Each variant maps every token you style with to a `#rrggbb` color. Tern
  also reads `#rgb` and the alpha forms (alpha is ignored) and skips any
  other value. Leave out a token you keep at the terminal's default.
- A token ending in `Bg` is a fill; every other token is a text color. Tern
  reads text tokens by name (omp's `toolTitle`, `mdHeading`,
  `statusLineModel`, `syntax*`, `toolDiff*`, `text` for the surface's body
  text, …). Of the fills it uses `toolSuccessBg`, `toolErrorBg`,
  `toolPendingBg`, `userMessageBg`, `customMessageBg`, `cardBg`, `infoBg`,
  `selectedBg` and `statusLineBg`; others, like `pageBg`, are ignored,
  since Tern owns the pane.
- `sf` names the surface; without it the palette goes to the live surface.
  An unknown `sf`, or no live surface, gets an `error` event. A `t` replaces
  the previous palette whole. Resend it whenever your theme or chosen
  variant changes; Tern applies it at once, with no frame needed.
- `name` is optional: your names for the two variants.
- The palette stays with the surface after close, so its scrollback keeps its
  colors.

With "Use program colors" on (the default):

- a span whose style names a palette token (`"statusLineModel"`) takes that
  token's color, as do the role colors;
- the semantic tokens and the tones resolve through it, the first token
  present winning:

  | Semantic token or tone | Palette tokens |
  | --- | --- |
  | `accent`, `success`, `warning`, `error`, `muted`, `dim` | the same name |
  | `ins` | `toolDiffAdded`, `success` |
  | `del` | `toolDiffRemoved`, `error` |
  | `link` | `mdLink`, `accent` |
  | `path` | `statusLinePath`, `mdLinkUrl` |
  | `code` | `mdCode` |
  | `num` | `syntaxNumber` |
  | `info` | `syntaxType` |
  | `mark` (its background) | `selectedBg` |
  | tones `accent`, `success`, `warning`, `error`, `muted` | the same name |

  The `info`, `pending`, `user` and `neutral` tones keep Tern's colors;
- fills become tints at 60% over Tern's surface, so its glass and hairlines
  survive: cards of tone `success`, `error`, `pending`, `user` and `info`
  take `toolSuccessBg`, `toolErrorBg`, `toolPendingBg`, `userMessageBg` and
  `infoBg`, other cards `cardBg`, omp's custom-message cards
  `customMessageBg`; `selectedBg` tints a list's selected `item` and
  `mark`, `statusLineBg` the `status` strip;
- `syntax*` and `md*` tokens color code highlighting, Markdown and its
  fences.

Tern still owns the pane around the surface, typography, layout and motion.
It corrects every text color for contrast against the surface and against
each tint it can land on: 4.5:1 for body text, 3:1 for quiet tokens
(`muted`, `dim`, `syntaxComment`, `mdHr`, borders and separators). With the
setting off, Tern resolves tones, tokens and roles through its own theme,
mapping your token names to the nearest semantic token; the palette is kept,
so switching back needs no resend.

Tern picks the variant matching its own appearance, reports the appearance
as `dark` in the `hello` reply and sends `{"ev":"theme","dark":bool}` when it
changes; a program with one variant gets that one either way.

The same document drawn in Tern's theme, then with omp's palette (60 tokens
per variant, sent as one `t` after the first frame):

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/protocol-theme-tern.light.png" srcset="../figures/protocol-theme-tern.light.png 2x" alt="A success card holding a path, a diff count, a model name and Rust code, and an error card with a warning, in Tern's own colors">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/protocol-theme-tern.dark.png" srcset="../figures/protocol-theme-tern.dark.png 2x" alt="A success card holding a path, a diff count, a model name and Rust code, and an error card with a warning, in Tern's own colors">
<figcaption>No palette: Tern's theme.</figcaption>
</figure>

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/protocol-theme-palette.light.png" srcset="../figures/protocol-theme-palette.light.png 2x" alt="The same two cards with omp's palette: accent, path, model, syntax colors and the card tints change">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/protocol-theme-palette.dark.png" srcset="../figures/protocol-theme-palette.dark.png 2x" alt="The same two cards with omp's palette: accent, path, model, syntax colors and the card tints change">
<figcaption>With omp's palette: <code>accent</code>, <code>path</code> (<code>statusLinePath</code>), <code>statusLineModel</code>, <code>code</code> (<code>mdCode</code>), the <code>syntax*</code> colors and the card tints change.</figcaption>
</figure>

The palette reaches style sheets as CSS variables (`--sf-p-<token>`, the
`--sf-c-*` and `--sf-tint-*` families): see
[CSS Variables](../styles/variables.md).

## Stylesheets

```text
ESC _ tsp;s;{"sf":"s1","name":"main","css":".ask label{display:flex;gap:8px}"} ESC \
```

`s` (feature `styles`) installs or replaces stylesheet `name` (1–64 of
`A–Z a–z 0–9 _ -`) of surface `sf`, the live surface when absent; a null,
absent or empty `css` removes it.

- A surface's sheets cascade after Tern's own in the order they were first
  sent; a replaced sheet keeps its place.
- They stay with the surface after close, so its scrollback keeps its look,
  and snapshots replay them.
- A surface holds at most 256 KiB of CSS, counted over all its sheets with
  the new text in place of the one it replaces. An `s` over that, with a bad
  name, with a `css` that isn't a string or for an unknown surface is
  rejected with an `error` event and changes nothing.
- **Confined to the surface.** Every selector is relative to the surface:
  `.ask label` matches inside its `main`, `dock` and `layer` regions and
  nowhere else. The region elements themselves are outside, so a selector
  naming `.sf-main` matches nothing. Tern's chrome, other panes and other
  surfaces are out of reach. The scope adds no specificity, so your rule
  beats a Tern rule of equal specificity.
- **Out of reach.** Declarations with `url()` and `position: fixed` are
  dropped and reported; `@font-face` is ignored and `@import` is reported
  as unsupported. A sheet's `@keyframes` are its own; an animation naming
  keyframes the sheet doesn't define gets Tern's.
- **Errors.** The window skips what it can't parse or drops and reports a
  sheet's problems once each time its CSS changes, all in one event:
  `{"ev":"error","sf","sheet":name,"msg":"<line>:<col>: …; <line>:<col>: …"}`.

A sheet that lays out a form of `el` nodes and squares off Tern's cards, which
it can reach because they sit inside the surface:

```css
.ask { display: flex; flex-direction: column; gap: 6px }
.ask label { display: flex; gap: 8px; align-items: center }
.ask .q { font-weight: 600; color: var(--sf-c-accent) }
.sf-card { border-radius: 4px }
```

```json
{"id":"n1","k":"card","p":{"tone":"pending","head":"Apply edits"},"c":[
 {"id":"n2","k":"el","p":{"tag":"form","class":"ask"},"c":[
  {"id":"n3","k":"el","p":{"tag":"div","class":"q","text":"Apply 3 edits to src/server.rs?"}},
  {"id":"n4","k":"el","p":{"tag":"label"},"c":[
   {"id":"n5","k":"el","p":{"tag":"input","type":"checkbox","checked":true}},
   {"id":"n6","k":"el","p":{"tag":"span","text":"Run tests after"}}]},
  {"id":"n7","k":"el","p":{"tag":"label"},"c":[
   {"id":"n8","k":"el","p":{"tag":"input","type":"checkbox"}},
   {"id":"n9","k":"el","p":{"tag":"span","text":"Commit when green"}}]}]}]}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/protocol-theme-sheet.light.png" srcset="../figures/protocol-theme-sheet.light.png 2x" alt="A card with square corners holding an accent question and two checkbox rows, laid out by the program's sheet">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/protocol-theme-sheet.dark.png" srcset="../figures/protocol-theme-sheet.dark.png 2x" alt="A card with square corners holding an accent question and two checkbox rows, laid out by the program's sheet">
</figure>

The hooks to target, the cascade and recipes are in
[Styling Views](../styles/index.md); what the CSS engine supports is in
[Supported CSS](../styles/css.md). Plugins don't send `s`: their sheets come
from the manifest and `tern.css`.

## Icons and glyphs

- **Named icons.** Fixed icon slots (`icon` nodes, an `item`'s or `seg`'s
  `icon`, the icon a `role` picks for a card) take names from Tern's icon set.
  The names are listed in [Data](../elements/data.md#icon-names).
- **Glyphs in text.** Icons inside running text are Nerd Font codepoints
  (Private Use Area) in spans with the `icon` token, keeping any color token
  (`"statusLineModel icon"`). Tern draws `icon` spans in its monospaced Nerd
  Font face at icon metrics, with its own gap when text follows, so drop the
  padding space you would put after a glyph in a terminal. Tern moves any
  other run of Private Use Area codepoints into an icon span itself, keeping
  its span's style: in spans without the `icon` token and in text that isn't
  spans (an editor's buffer, `md` prose). Don't send emoji or Unicode
  stand-ins for icons.
