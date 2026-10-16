# Supported CSS

Tern draws plugin views with its own engine, not a browser. It accepts a defined subset of CSS, plus a few
Stencil extensions. This page lists exactly what the engine
accepts, what it ignores, and what it rejects. For where your sheet comes from and which classes to target, see
[Styling views](index.md). For the theme variables, see [CSS variables](variables.md).

## Where your CSS goes

| Source | Sheet name | Scope |
| --- | --- | --- |
| Manifest `styles` | `plugin:<host>:<id>:styles` (`plugin:local:<id>:styles` on this machine) | Global author sheet |
| `tern.css(name, source)` | `plugin:local:<id>:<name>` | Global author sheet |
| A TSP program's surface sheets | `tsp:<scope>:<name>` | Confined to its surface (see [Scoped sheets](#scoped-sheets)) |

A plugin sheet is a normal author sheet. Its rules can match anything in the window, so prefix your selectors with your
block's region (`[data-surface="plugin.<plugin>.<block>"]`) or your own classes. A new sheet goes last in the cascade;
replacing a sheet (a reload, or another `tern.css` call with the same name) keeps its place.

### Errors

The parser never fails a whole sheet. It drops what it cannot use and keeps the rest:

| What | Result |
| --- | --- |
| Unknown property | Declaration dropped, error `unknown property` |
| Known property, invalid value | Declaration dropped, error |
| Ignored property (see below) | Declaration dropped silently |
| Unsupported selector, pseudo-class or pseudo-element | Whole rule dropped (all its selectors), error |
| Unsupported at-rule (`@import`, `@layer`, `@supports`, `@container`, …) | At-rule dropped, error `unsupported at-rule` |
| Unsupported media feature or value | The `@media` block dropped, error |
| `var()` that resolves to nothing, without fallback | Property treated as `unset` for that element (no error) |
| `var()` that resolves to an invalid value | Property treated as `unset` for that element (no error) |

For a plugin sheet, Tern logs the errors as a warning `plugin style sheet has errors`, with the sheet name and each
error as `file:line:column: message`. Look for it in Tern's log. For a TSP surface sheet, the errors come back to the
program as one `error` event per sheet: `sheet` holds the sheet name and `msg` every error as
``line:column: message in `snippet` ``, joined with `; `:

```text
{"ev":"error","sheet":"main","msg":"2:6: unsupported length unit `rem` in `width: 2rem;`; 3:1: unsupported pseudo-class `:enabled` in `.t:enabled {`","sf":"s1"}
```

These properties are accepted and dropped with no error, for compatibility with web stylesheets:
`-moz-osx-font-smoothing`, `text-rendering`, `-webkit-tap-highlight-color`, `-webkit-box-orient`.

## Syntax

### Rules and nesting

Style rules, `@media`, `@keyframes` (also `@-webkit-keyframes`) and `@font-face` are the only rules. CSS Nesting works
and flattens into plain rules at parse time:

```css
.my-panel {
	padding: 8px;

	& .title { font-weight: 600; }   /* .my-panel .title */
	> .row { display: flex; }        /* .my-panel > .row */
	.note { opacity: .7; }           /* .my-panel .note (no & means descendant) */
	&.busy { cursor: progress; }     /* .my-panel.busy */
	.dark & { color: white; }        /* .dark .my-panel */

	@media (max-width: 600px) { padding: 4px; }

	color: gray;  /* after nested rules: a later rule of its own, so it wins ties */
}
```

- `&` stands for the parent selector list. Each `&` counts as the most specific parent for specificity.
- A nested selector without `&` is relative: a leading `>` or `+` uses that combinator, else descendant.
- A nested selector cannot both start with a combinator and contain `&`.
- Nothing can nest inside a rule whose selector ends in a pseudo-element.
- Only `@media` can nest inside a style rule. A nested `@keyframes` is an error.

### `!important`

`!important` works on any declaration, custom properties included. The cascade applies all normal declarations, then
all `!important` ones, so an important declaration beats any normal one.

### Cascade order

For one element, declarations win in this order (later wins):

1. Tern's user-agent sheet.
2. Author rules (Tern's built-in sheets, then plugin sheets), by specificity, then by sheet order, then by position in
   the sheet. Because plugin sheets register after Tern's, your rule beats Tern's rule of equal specificity.
3. The element's inline style.
4. Then the same order again for `!important` declarations.

Running transitions, then CSS animations, then script animations paint over the cascaded value. See
[Styling views](index.md) for how this plays with Tern's own classes.

### CSS-wide keywords

Every property accepts `inherit`, `initial` and `unset`. `revert` and `revert-layer` are not supported. The `all`
property accepts only these three keywords.

### Inheritance

Properties marked "Inherited: yes" in the tables below inherit by default; the rest reset to their initial value.
Custom properties always inherit.

## Values

### Lengths and percentages

| Unit | Meaning |
| --- | --- |
| `px` | CSS pixels |
| `em` | The element's font size (for `font-size`, the parent's) |
| `vw`, `vh` | 1% of the window's width or height |
| `%` | Percentage of the property's reference (containing block, etc.) |
| `0` | A bare zero is a length |

No other length unit parses: `rem`, `ch`, `ex`, `lh`, `vmin`, `vmax`, `dvh`, `cm`, `pt` and the rest are rejected with
`unsupported length unit`. Use `em` or `px`, or a `var()` from [CSS variables](variables.md).

Bare numbers count as px only in SVG properties (`stroke-width`, `stroke-dashoffset`, `stroke-dasharray`).

`em`, `vw` and `vh` compute to px, so inherited lengths (`letter-spacing`, …) inherit the absolute value.

### Math functions

`calc()`, `min()`, `max()` and `clamp()` work wherever a length or percentage is accepted, and nest. They take `+`,
`-`, `*`, `/`, parentheses and the length units above:

```css
.side { width: clamp(160px, 30%, 320px); }
.gap  { margin-top: calc(1em + 2px); }
```

Times also take math (`calc(2 * 30ms)`), folded at parse time. Other math functions (`round()`, `abs()`, `sin()`, …)
are rejected.

### Other units

| Type | Units |
| --- | --- |
| `<time>` | `s`, `ms` |
| `<angle>` | `deg`, `rad`, `grad`, `turn` (a bare `0` is allowed) |
| Grid track | `fr` |

### Colors

| Syntax | Notes |
| --- | --- |
| `#rgb` `#rgba` `#rrggbb` `#rrggbbaa` | Hex |
| Named colors (`red`, `rebeccapurple`, …) | All CSS named colors |
| `transparent`, `currentColor` | `currentColor` stays live and follows the element's `color` |
| `rgb()` / `rgba()` | Legacy comma syntax and modern space syntax with `/ alpha` |
| `hsl()` / `hsla()` | Hue as a number or `deg`; saturation and lightness as percentages. Comma or space syntax. |
| `oklab()`, `oklch()` | Modern syntax, `none` components allowed (`rgb()` and `hsl()` take no `none`) |
| Relative colors: `rgb(from <color> r g b / a)` | Also `hsl(from …)` (`h s l`), `oklab(from …)` (`l a b`), `oklch(from …)` (`l c h`), with `alpha` and math on channels. The origin cannot be `currentColor`. |
| `color-mix(in <space> [<hue-method> hue], <color> [<p>%], <color> [<p>%])` | Spaces: `srgb` `srgb-linear` `hsl` `hwb` `lab` `lch` `oklab` `oklch` `xyz` `xyz-d50` `xyz-d65`. Hue methods: `shorter` `longer` `increasing` `decreasing`. Percentages 0–100%, not both zero. Operands cannot be `currentColor`. |
| `light-dark(<light>, <dark>)` | Picks a branch per element, from its computed `color-scheme`: `dark` when it lists `dark` and not `light`, else light. Works in any value and inside custom properties. |

`hwb()`, `lab()`, `lch()` and `color()` are not color functions here (they only name `color-mix()` spaces); they are
rejected with `unsupported color function`. System colors (`Canvas`, `ButtonText`, …) are rejected.

### Custom properties and `var()`

`--name: <anything>` declares a custom property; it inherits. `var(--name)` and `var(--name, fallback)` work in any
value, nest inside fallbacks, and can reference other custom properties. A reference cycle, or a chain more than 32
levels deep, fails like a missing variable. A value with `var()` or `light-dark()` is checked per element after
substitution, so a shorthand containing `var()` expands only then. `@property` is not supported: custom properties are
untyped and do not animate.

### Positions

A `<position>` (`background-position`, `mask-position`, `transform-origin`, a radial gradient's `at`) takes one,
two or four components: `center`, `left 20%`, `30% 8px`, `right 8px bottom 4px`. Keywords are `left`, `right`,
`top`, `bottom` and `center`. Three-value positions (`left 10px top`) are rejected.

### Images

`background-image`, `mask-image` and `list-style-image` accept `none`, `url()`, `linear-gradient()`,
`repeating-linear-gradient()`, `radial-gradient()` and `repeating-radial-gradient()`:

- Linear direction: `<angle>` or `to <side or corner>` (default: to bottom).
- Radial: `circle` / `ellipse`, `closest-side` / `closest-corner` / `farthest-side` / `farthest-corner` or explicit
  sizes, `at <position>` (default: ellipse, farthest-corner, at center).
- Color stops take one or two positions; a gradient needs at least two stops. A stop color cannot be
  `currentColor`.
- The `repeating-` forms repeat their stop range: stripes along the gradient line, concentric rings outward
  from the center.
- `url()` paints in `background-image` only: a `data:` image, or in a plugin's global sheets a file of the
  plugin ([Chrome and Styling](../guides/chrome.md#images-url)). A view's own stylesheets drop `url()`, and
  `mask-image` takes gradients.

```css
.linear  { background: linear-gradient(135deg, var(--a1), var(--a2)); }
.stripes { background: repeating-linear-gradient(45deg, var(--accent) 0 6px, transparent 6px 12px); }
.radial  { background: radial-gradient(circle closest-side, #fff, var(--accent) 70%, transparent 72%); }
.rings   { background: repeating-radial-gradient(circle, var(--accent) 0 3px, transparent 3px 8px); }
.layers  {
	background:
		radial-gradient(circle at 25% 30%, rgb(255 255 255 / 60%), transparent 40%),
		linear-gradient(to right, var(--ok), var(--accent));
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-css-gradients.light.png" srcset="../figures/styles-css-gradients.light.png 2x" alt="Five tiles: a diagonal blue linear gradient, blue diagonal stripes, a white-to-blue radial disc, blue concentric rings, and a green-to-blue gradient with a white highlight layered on top">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-css-gradients.dark.png" srcset="../figures/styles-css-gradients.dark.png 2x" alt="Five tiles: a diagonal blue linear gradient, blue diagonal stripes, a white-to-blue radial disc, blue concentric rings, and a green-to-blue gradient with a white highlight layered on top">
<figcaption>The five rules above, one tile each.</figcaption>
</figure>

`conic-gradient()`, `image-set()` and `cross-fade()` are rejected with `unsupported image function`. Stencil adds
three native image functions. Coordinates are relative to the box's top-left corner; percentages are of its width
or height, and radius percentages of its shorter side:

| Function | Paints |
| --- | --- |
| `color-field(anchor(<color>, <x> <y>, <radius> [, <ax> <ay>, <fx> <fy>, <px> <py>])#)` | Soft color blobs, each fading out at its radius. The optional triple makes an anchor drift: amplitude (lengths), frequency (radians per second) and phase per axis, sampled at `-stencil-time`. |
| `mesh-gradient(vertices(vertex(<color>, <x> <y>)#), triangles(triangle(<i> <j> <k>)#))` | Triangles with colors interpolated between their vertices. Needs at least three vertices; indices are 0-based and distinct. |
| `perimeter-gradient(<radius>, <phase>, <color-stops>)` | Color stops laid clockwise around a rounded rectangle of corner radius `<radius>`; `<phase>` (turns) rotates the start. |

```css
.field {
	border-radius: 10px;
	background: color-field(
		anchor(var(--a1), 20% 30%, 90%),
		anchor(var(--a2), 80% 70%, 90%),
		anchor(var(--ok), 75% 0, 50%));
}
.mesh {
	border-radius: 10px;
	background: mesh-gradient(
		vertices(vertex(var(--a1), 0 0), vertex(var(--a2), 100% 0),
			vertex(var(--ok), 100% 100%), vertex(var(--warn), 0 100%)),
		triangles(triangle(0 1 2), triangle(0 2 3)));
}
.edge {
	border-radius: 10px;
	background: perimeter-gradient(10px, 0, var(--a1), var(--a2), var(--ok), var(--a1));
}
.blob {
	background: var(--accent);
	-stencil-shape: shape-union(12px,
		round-rect(0 0 60% 60% / 12px),
		round-rect(40% 40% 60% 60% / 12px));
}
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-css-native.light.png" srcset="../figures/styles-css-native.light.png 2x" alt="Four tiles: soft overlapping color blobs, a four-corner mesh gradient, a perimeter gradient whose colors run around the edge, and two rounded rectangles merged into one smooth shape">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-css-native.dark.png" srcset="../figures/styles-css-native.dark.png 2x" alt="Four tiles: soft overlapping color blobs, a four-corner mesh gradient, a perimeter gradient whose colors run around the edge, and two rounded rectangles merged into one smooth shape">
<figcaption>The native image functions, and <code>-stencil-shape</code> (see <a href="#stencil-extensions">Stencil extensions</a>).</figcaption>
</figure>

### Transforms

`transform` takes `translate()`, `translateX()`, `translateY()`, `translateZ()`, `translate3d()`, `scale()`,
`scaleX()`, `scaleY()`, `scaleZ()`, `scale3d()`, `rotate()`, `rotateX()`, `rotateY()`, `rotateZ()`, `rotate3d()`,
`skew()`, `skewX()`, `skewY()`, `matrix()`, `matrix3d()` and `perspective()` (a length or `none`). The individual
`translate`, `rotate` and `scale` properties work too. A 3D rotation shows depth when an ancestor sets
`perspective`:

```css
.slot   { perspective: 200px; }
.rotate { transform: rotate(-12deg); }
.skew   { transform: skewX(-15deg); }
.scale  { transform: scale(.7) translateX(12px); }
.flip   { transform: rotateY(50deg); transform-origin: left center; }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-css-transforms.light.png" srcset="../figures/styles-css-transforms.light.png 2x" alt="Four dashed slots, each holding a gradient box: rotated, skewed, scaled down and shifted, and turned around its left edge in perspective">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-css-transforms.dark.png" srcset="../figures/styles-css-transforms.dark.png 2x" alt="Four dashed slots, each holding a gradient box: rotated, skewed, scaled down and shifted, and turned around its left edge in perspective">
<figcaption>Each box against its untransformed slot (dashed).</figcaption>
</figure>

### Filters

`filter` and `backdrop-filter` take `blur()`, `brightness()`, `contrast()`, `grayscale()`, `invert()`, `opacity()`,
`saturate()`, `sepia()`, `hue-rotate()`, `drop-shadow()` and `url()`. Amounts are numbers or percentages (no
negatives); an empty function takes its default (`1` for amounts, `0` for `blur()` and `hue-rotate()`).
`drop-shadow()` takes `x y [blur]` and a color, without `inset` or spread.

```css
.box  {
	height: 56px;
	border-radius: 8px;
	background: light-dark(#fff, #2c2e36);
	--shade: light-dark(rgb(0 0 0 / 35%), rgb(0 0 0 / 90%));
}
.gray, .blur, .hue, .dim { background: linear-gradient(135deg, var(--a1), var(--a2)); }
.glow { background: var(--accent); }
.soft { box-shadow: 0 6px 16px -4px var(--shade); }
.ring { box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px rgb(from var(--accent) r g b / 25%); }
.inset { box-shadow: inset 0 2px 6px var(--shade); }
.glow { filter: drop-shadow(0 0 8px var(--accent)); }
.gray { filter: grayscale(1); }
.blur { filter: blur(4px); }
.hue  { filter: hue-rotate(120deg) saturate(1.5); }
.dim  { filter: brightness(.6) contrast(1.4); }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-css-shadows.light.png" srcset="../figures/styles-css-shadows.light.png 2x" alt="Top row: boxes with a soft drop shadow, a two-ring focus outline, an inset shadow and a glowing drop-shadow filter. Bottom row: a gradient box grayscaled, blurred, hue-rotated and darkened">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-css-shadows.dark.png" srcset="../figures/styles-css-shadows.dark.png 2x" alt="Top row: boxes with a soft drop shadow, a two-ring focus outline, an inset shadow and a glowing drop-shadow filter. Bottom row: a gradient box grayscaled, blurred, hue-rotated and darkened">
<figcaption>Top: <code>box-shadow</code> and <code>drop-shadow()</code>. Bottom: the same gradient through four filters.</figcaption>
</figure>

Stencil adds native filter functions:

| Function | Effect |
| --- | --- |
| `analytic-lens(<band>, <r> <g> <b> [, <pre-blur>])` | Refraction along the element's shape (its `-stencil-shape` when set) over an edge band `<band>` wide; `<r> <g> <b>` are signed per-channel displacement lengths, `<pre-blur>` a blur applied first. |
| `ripple(<x> <y>, <amplitude>, <frequency>, <decay>, <speed>)` | A ripple from `<x> <y>`, driven by `-stencil-time` (none at 0): displacement length, angular frequency, exponential decay, wavefront speed in px/s. Off under reduced motion. |
| `color-matrix(<20 numbers>)` | Four rows of five: an affine RGBA color matrix. |
| `variable-blur(<sigma>, <image>)` | Blur up to `<sigma>`, scaled by the alpha of a gradient (or `url()`) mask over the box. |
| `snapshot-warp(<progress>, <x> <y> <w> <h> [, <curvature>])` | Warps the element toward the target rectangle as `<progress>` goes 0→1 (curvature default 0.35). |
| `dissolve(<progress> [, <seed>])` | Seeded dissolve of the element's coverage as `<progress>` rises from 0 (intact). |

### Easing functions

`linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `step-start`, `step-end`, `cubic-bezier(x1, y1, x2, y2)` (x in
0–1), `steps(n [, jump-start | jump-end | jump-none | jump-both | start | end])` (n ≥ 1, ≥ 2 with `jump-none`) and
the Stencil extension `spring(<duration>, <bounce>)` (duration > 0, bounce in −1…1, exclusive). The `linear(…)`
function with stops is not supported.

## Properties

Vendor aliases map to the standard property: `-webkit-backdrop-filter`, `-webkit-mask` and every `-webkit-mask-*`
longhand (legacy `-webkit-mask-composite` operators `xor`, `source-over`, `source-in`, `source-out` translate),
`-webkit-background-clip`, `-webkit-user-select`, `-webkit-transform`, `-webkit-filter`, `-webkit-app-region`,
`-webkit-line-clamp`, `word-wrap` (→ `overflow-wrap`), `grid-gap`, `grid-row-gap`, `grid-column-gap`.

"Animates" means transitions and animations interpolate the property; the others switch discretely. `#` marks a
comma-separated list.

¹ Alignment keywords: `normal` `auto` `stretch` `center` `start` `end` `flex-start` `flex-end` `self-start`
`self-end` `baseline` `space-between` `space-around` `space-evenly` `left` `right` `legacy`.<br>
² Track list: `<length-percentage>`, `<n>fr`, `auto`, `min-content`, `max-content`, `minmax(a, b)` and
`repeat(<integer>, tracks…)`. No `repeat(auto-fill, …)`, no named lines, no `grid-template-areas`.<br>
³ See [Images](#images).<br>
⁴ See [Transforms](#transforms). ⁵ See [Filters](#filters). ⁶ See [Easing functions](#easing-functions).

### Box and position

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `display` | `none` `block` `inline` `inline-block` `flex` `inline-flex` `grid` `inline-grid` `contents` `list-item` `flow-root` `table` `table-row` `table-cell` `table-row-group` `table-header-group` `-webkit-box` `-webkit-inline-box` | `inline` | no | no |
| `position` | `static` `relative` `absolute` `fixed` `sticky` | `static` | no | no |
| `top` | `auto` \| `<length-percentage>` | `auto` | no | yes |
| `right` | same as `top` | `auto` | no | yes |
| `bottom` | same as `top` | `auto` | no | yes |
| `left` | same as `top` | `auto` | no | yes |
| `z-index` | `auto` \| `<integer>` | `auto` | no | yes |
| `box-sizing` | `content-box` `border-box` | `content-box` | no | no |
| `width` | `auto` `min-content` `max-content` `content` \| `<length-percentage>` | `auto` | no | yes |
| `height` | same as `width` | `auto` | no | yes |
| `min-width` | same as `width` | `auto` | no | yes |
| `min-height` | same as `width` | `auto` | no | yes |
| `max-width` | `none` `min-content` `max-content` \| `<length-percentage>` | `none` | no | yes |
| `max-height` | same as `max-width` | `none` | no | yes |
| `margin-top` | `auto` \| `<length-percentage>` (negative allowed) | `0` | no | yes |
| `margin-right` | same as `margin-top` | `0` | no | yes |
| `margin-bottom` | same as `margin-top` | `0` | no | yes |
| `margin-left` | same as `margin-top` | `0` | no | yes |
| `padding-top` | `<length-percentage>` | `0` | no | yes |
| `padding-right` | `<length-percentage>` | `0` | no | yes |
| `padding-bottom` | `<length-percentage>` | `0` | no | yes |
| `padding-left` | `<length-percentage>` | `0` | no | yes |
| `overflow-x` | `visible` `hidden` `clip` `scroll` `auto` | `visible` | no | no |
| `overflow-y` | same as `overflow-x` | `visible` | no | no |
| `visibility` | `visible` `hidden` `collapse` | `visible` | yes | no |
| `zoom` | `normal` \| `<number>` \| `<percentage>` (≥ 0; `0` = `normal`) | `1` | yes | no |

### Flex and grid

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `flex-direction` | `row` `row-reverse` `column` `column-reverse` | `row` | no | no |
| `flex-wrap` | `nowrap` `wrap` `wrap-reverse` | `nowrap` | no | no |
| `flex-grow` | `<number>` ≥ 0 | `0` | no | yes |
| `flex-shrink` | `<number>` ≥ 0 | `1` | no | yes |
| `flex-basis` | same as `width` | `auto` | no | yes |
| `order` | `<integer>` | `0` | no | yes |
| `align-items` | alignment keywords¹ | `normal` | no | no |
| `align-self` | alignment keywords¹ | `auto` | no | no |
| `align-content` | alignment keywords¹ | `normal` | no | no |
| `justify-content` | alignment keywords¹ | `normal` | no | no |
| `justify-items` | alignment keywords¹ | `legacy` | no | no |
| `justify-self` | alignment keywords¹ | `auto` | no | no |
| `row-gap` | `normal` \| `<length-percentage>` | `normal` | no | yes |
| `column-gap` | `normal` \| `<length-percentage>` | `normal` | no | yes |
| `grid-template-columns` | `none` \| track list² | `none` | no | yes |
| `grid-template-rows` | `none` \| track list² | `none` | no | yes |
| `grid-column` | `<line> [/ <line>]`, line = `auto` \| `span <integer>` \| `<integer>` | `auto` | no | no |
| `grid-row` | same as `grid-column` | `auto` | no | no |

### Color and background

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `color` | `<color>` | `black` | yes | yes |
| `color-scheme` | `normal` \| `light` and/or `dark` | `normal` | yes | no |
| `opacity` | `<number>` or `<percentage>`, clamped to 0–1 | `1` | no | yes |
| `background-color` | `<color>` | `transparent` | no | yes |
| `background-image` | `<image>#`³ | `none` | no | yes |
| `background-position` | `<position>#` | `0% 0%` | no | yes |
| `background-size` | (`cover` \| `contain` \| `auto`/`<length-percentage>` {1,2})# | `auto` | no | yes |
| `background-repeat` | (`repeat-x` \| `repeat-y` \| [`repeat` `no-repeat` `space` `round`]{1,2})# | `repeat` | no | no |
| `background-origin` | (`border-box` `padding-box` `content-box`)# | `padding-box` | no | no |
| `background-clip` | (`border-box` `padding-box` `content-box` `text`)# | `border-box` | no | no |
| `object-fit` | `fill` `contain` `cover` `none` `scale-down` | `fill` | no | no |
| `image-rendering` | `auto` `smooth` `high-quality` `pixelated` `crisp-edges` | `auto` | yes | no |

`object-fit` places the pixels of an [`image` node](../elements/data.md#image) in its box, always centered
(`object-position` is not supported); the node's frame inherits it, and Tern's sheet makes `contain` the image
default. `image-rendering: pixelated` and `crisp-edges` scale images, `url()` backgrounds included, with the nearest
pixel (hard pixel-art edges); the other values scale smoothly.

### Borders and outline

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `border-top-width` | `thin` (1px) `medium` (3px) `thick` (5px) \| `<length>` (no %) | `medium` | no | yes |
| `border-right-width` | same as `border-top-width` | `medium` | no | yes |
| `border-bottom-width` | same as `border-top-width` | `medium` | no | yes |
| `border-left-width` | same as `border-top-width` | `medium` | no | yes |
| `border-top-style` | `none` `hidden` `solid` `dashed` `dotted` `double` `groove` `ridge` `inset` `outset` `auto` | `none` | no | no |
| `border-right-style` | same as `border-top-style` | `none` | no | no |
| `border-bottom-style` | same as `border-top-style` | `none` | no | no |
| `border-left-style` | same as `border-top-style` | `none` | no | no |
| `border-top-color` | `<color>` | `currentcolor` | no | yes |
| `border-right-color` | `<color>` | `currentcolor` | no | yes |
| `border-bottom-color` | `<color>` | `currentcolor` | no | yes |
| `border-left-color` | `<color>` | `currentcolor` | no | yes |
| `border-top-left-radius` | `<length-percentage>` [`<length-percentage>`] (horizontal, vertical) | `0` | no | yes |
| `border-top-right-radius` | same | `0` | no | yes |
| `border-bottom-right-radius` | same | `0` | no | yes |
| `border-bottom-left-radius` | same | `0` | no | yes |
| `border-collapse` | `collapse` `separate` | `separate` | yes | no |
| `outline-width` | same as `border-top-width` | `medium` | no | yes |
| `outline-style` | same as `border-top-style` | `none` | no | no |
| `outline-color` | `<color>` | `currentcolor` | no | yes |
| `outline-offset` | `<length-percentage>` | `0` | no | yes |

### Effects, transforms and masks

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `box-shadow` | `none` \| (`inset`? x y [blur [spread]] `<color>`?)# | `none` | no | yes |
| `transform` | `none` \| transform functions⁴ | `none` | no | yes |
| `transform-origin` | `<position>` [z length, ignored] | `50% 50%` | no | yes |
| `translate` | `none` \| `<length-percentage>` [`<length-percentage>` [`<length>`]] | `none` | no | yes |
| `rotate` | `none` \| `<angle>` \| `x`/`y`/`z`/`<number>{3}` `<angle>` | `none` | no | yes |
| `scale` | `none` \| `<number>`/`<percentage>` {1,3} | `none` | no | yes |
| `perspective` | `none` \| `<length>` | `none` | no | yes |
| `perspective-origin` | `<position>` | `50% 50%` | no | yes |
| `filter` | `none` \| filter functions⁵ | `none` | no | yes |
| `backdrop-filter` | same as `filter` | `none` | no | yes |
| `mix-blend-mode` | `normal` `multiply` `screen` `overlay` `darken` `lighten` `color-dodge` `color-burn` `hard-light` `soft-light` `difference` `exclusion` `hue` `saturation` `color` `luminosity` `plus-lighter` | `normal` | no | no |
| `isolation` | `auto` `isolate` | `auto` | no | no |
| `clip-path` | `none` \| `inset(<length-percentage>{1,4} [round <radius>])` | `none` | no | yes |
| `mask-image` | `<image>#`³ | `none` | no | no |
| `mask-position` | `<position>#` | `0% 0%` | no | yes |
| `mask-size` | same as `background-size` | `auto` | no | yes |
| `mask-repeat` | same as `background-repeat` | `repeat` | no | no |
| `mask-origin` | (`border-box` `padding-box` `content-box`)# | `border-box` | no | no |
| `mask-clip` | (`border-box` `padding-box` `content-box` `no-clip`)# | `border-box` | no | no |
| `mask-composite` | (`add` `subtract` `intersect` `exclude`)# | `add` | no | no |
| `mask-mode` | (`alpha` `luminance` `match-source`)# | `match-source` | no | no |
| `will-change` | `auto` \| idents# | `auto` | no | no |

### Text and fonts

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `font-family` | family names (quoted or bare) and generics: `serif` `sans-serif` `monospace` `cursive` `fantasy` `system-ui` (`-apple-system`, `BlinkMacSystemFont`) `ui-monospace` `ui-sans-serif` `ui-serif` `ui-rounded` | `sans-serif` | yes | no |
| `font-size` | `<length-percentage>` | `16px` | yes | yes |
| `font-weight` | `normal` `bold` `bolder` `lighter` \| `<number>` 1–1000 | `normal` | yes | yes |
| `font-style` | `normal` `italic` `oblique` | `normal` | yes | no |
| `line-height` | `normal` \| `<number>` \| `<length-percentage>` | `normal` | yes | yes |
| `letter-spacing` | `normal` \| `<length-percentage>` | `normal` | yes | yes |
| `text-align` | `left` `right` `center` `justify` `start` `end` `match-parent` | `start` | yes | no |
| `text-decoration-line` | `none` \| any of `underline` `overline` `line-through` | `none` | no | no |
| `text-decoration-style` | `solid` `double` `dotted` `dashed` `wavy` | `solid` | no | no |
| `text-decoration-color` | `<color>` | `currentcolor` | no | yes |
| `text-overflow` | `clip` `ellipsis` | `clip` | no | no |
| `line-clamp` | `none` \| `<integer>` ≥ 1 | `none` | no | no |
| `white-space` | `normal` `nowrap` `pre` `pre-wrap` `pre-line` `break-spaces` | `normal` | yes | no |
| `word-break` | `normal` `break-all` `keep-all` `break-word` | `normal` | yes | no |
| `overflow-wrap` | `normal` `break-word` `anywhere` | `normal` | yes | no |
| `text-wrap` | `wrap` `nowrap` `balance` `pretty` `stable` | `wrap` | yes | no |
| `text-transform` | `none` `uppercase` `lowercase` `capitalize` | `none` | yes | no |
| `font-variant-numeric` | `normal` \| any of `tabular-nums` `proportional-nums` `lining-nums` `oldstyle-nums` `diagonal-fractions` `stacked-fractions` `ordinal` `slashed-zero` | `normal` | yes | no |
| `-webkit-font-smoothing` | `auto` `none` `antialiased` `subpixel-antialiased` | `auto` | yes | no |
| `-stencil-text-snap` | `none` `pixel` | `none` | yes | no |
| `tab-size` | `<number>` \| `<length>` | `8` | yes | yes |
| `vertical-align` | `baseline` `sub` `super` `text-top` `text-bottom` `middle` `top` `bottom` \| `<length-percentage>` | `baseline` | no | yes |
| `list-style-type` | `none` `disc` `circle` `square` `decimal` \| `<string>` | `disc` | yes | no |
| `list-style-position` | `inside` `outside` | `outside` | yes | no |
| `list-style-image` | `<image>` | `none` | yes | no |
| `content` | `normal` `none` \| sequence of `<string>` and `attr(<name>)` | `normal` | no | no |
| `caret-color` | `auto` \| `<color>` | `auto` | yes | yes |

### Interaction and scrolling

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `cursor` | CSS UI keywords: `auto` `default` `none` `pointer` `text` `grab` `grabbing` `zoom-in` `zoom-out` `crosshair` `move` `not-allowed` `wait` `progress` `help` `context-menu` `cell` `vertical-text` `alias` `copy` `no-drop` `all-scroll` `col-resize` `row-resize` `n-resize` `e-resize` `s-resize` `w-resize` `ne-resize` `nw-resize` `se-resize` `sw-resize` `ew-resize` `ns-resize` `nesw-resize` `nwse-resize` (no `url()`) | `auto` | yes | no |
| `pointer-events` | `auto` `none` `all` `visible` | `auto` | yes | no |
| `user-select` | `auto` `none` `text` `all` `contain` | `auto` | no | no |
| `touch-action` | `auto` `none` `manipulation` \| any of `pan-x` `pan-y` `pinch-zoom` | `auto` | no | no |
| `scrollbar-width` | `auto` `thin` `none` | `auto` | no | no |
| `scrollbar-color` | `auto` \| `<color> <color>` (thumb, track) | `auto` | yes | no |
| `overscroll-behavior` | `auto` `contain` `none` {1,2} (x, y) | `auto` | no | no |
| `scroll-behavior` | `auto` `smooth` | `auto` | no | no |
| `overflow-anchor` | `auto` `none` | `auto` | no | no |
| `scroll-padding-top` | `auto` \| `<length-percentage>` | `auto` | no | no |
| `scroll-padding-right` | same | `auto` | no | no |
| `scroll-padding-bottom` | same | `auto` | no | no |
| `scroll-padding-left` | same | `auto` | no | no |
| `scroll-snap-type` | `none` \| (`x` `y` `block` `inline` `both`) [`mandatory` \| `proximity`] | `none` | no | no |
| `scroll-snap-align` | (`none` `start` `end` `center`){1,2} | `none` | no | no |
| `scroll-snap-stop` | `normal` `always` | `normal` | no | no |
| `app-region` | `none` `drag` `no-drag` | `none` | no | no |

### Transitions and animations

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `transition-property` | `all` \| `none` \| property names# (unknown names are accepted and ignored) | `all` | no | no |
| `transition-duration` | `<time>#` | `0s` | no | no |
| `transition-timing-function` | `<easing>#`⁶ | `ease` | no | no |
| `transition-delay` | `<time>#` | `0s` | no | no |
| `animation-name` | `none` \| name (ident or string)# | `none` | no | no |
| `animation-duration` | `<time>#` | `0s` | no | no |
| `animation-timing-function` | `<easing>#`⁶ | `ease` | no | no |
| `animation-delay` | `<time>#` | `0s` | no | no |
| `animation-iteration-count` | `infinite` \| `<number>` ≥ 0, # | `1` | no | no |
| `animation-direction` | (`normal` `reverse` `alternate` `alternate-reverse`)# | `normal` | no | no |
| `animation-fill-mode` | (`none` `forwards` `backwards` `both`)# | `none` | no | no |
| `animation-play-state` | (`running` `paused`)# | `running` | no | no |

### SVG painting

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `fill` | same as `stroke` | `black` | yes | yes |
| `fill-opacity` | alpha 0–1 | `1` | yes | yes |
| `stroke` | `none` \| `url()` \| `<color>` | `none` | yes | yes |
| `stroke-width` | `<length-percentage>` or bare number | `1` | yes | yes |
| `stroke-linecap` | `butt` `round` `square` | `butt` | yes | no |
| `stroke-linejoin` | `miter` `round` `bevel` | `miter` | yes | no |
| `stroke-miterlimit` | `<number>` ≥ 0 | `4` | yes | yes |
| `stroke-dasharray` | `none` \| lengths/numbers (space or comma separated) | `none` | yes | yes |
| `stroke-dashoffset` | `<length-percentage>` or bare number | `0` | yes | yes |
| `stroke-opacity` | alpha 0–1 | `1` | yes | yes |
| `stop-color` | `<color>` | `black` | no | yes |
| `stop-opacity` | alpha 0–1 | `1` | no | yes |
| `rx` | `auto` \| `<length-percentage>` | `auto` | no | yes |
| `ry` | `auto` \| `<length-percentage>` | `auto` | no | yes |

### Reset

| Property | Values | Initial | Inherited | Animates |
| --- | --- | --- | --- | --- |
| `all` | CSS-wide keywords only | `unset` | no | no |

### Shorthands

A shorthand expands to its longhands when the sheet is parsed (or, with `var()`/`light-dark()` inside, per element).
Longhands you leave out reset to their initial value.

| Shorthand | Sets | Syntax |
| --- | --- | --- |
| `margin`, `padding`, `inset`, `scroll-padding` | the four sides | 1–4 values (top right bottom left) |
| `border-width`, `border-style`, `border-color` | the four sides | 1–4 values |
| `border-top`, `-right`, `-bottom`, `-left` | width, style, color of one side | `width ‖ style ‖ color` |
| `border` | all twelve side longhands | `width ‖ style ‖ color` |
| `border-radius` | the four corners | `h{1,4} [/ v{1,4}]` |
| `outline` | `outline-width`, `-style`, `-color` | `width ‖ style ‖ color` |
| `background` | color, image, position, size, repeat, origin, clip | layers#, `position [/ size]`; only the last layer may hold a color; `background-attachment` keywords are accepted and dropped |
| `mask` | image, position, size, repeat, origin, clip, composite, mode | layers# |
| `font` | style, weight, size, line-height, family | `[style ‖ weight] size[/line-height] family` (no `font-variant`, no system fonts) |
| `flex` | grow, shrink, basis | `none` (0 0 auto), `auto` (1 1 auto), `<grow> [<shrink>] ‖ <basis>` (omitted grow/shrink 1, basis 0%) |
| `flex-flow` | direction, wrap | `direction ‖ wrap` |
| `gap` | `row-gap`, `column-gap` | `row [column]` |
| `place-items` | `align-items`, `justify-items` | `align [justify]` |
| `place-content` | `align-content`, `justify-content` | `align [justify]` |
| `overflow` | `overflow-x`, `overflow-y` | `x [y]` |
| `grid-template` | rows, columns | `none` \| `rows / columns` |
| `text-decoration` | line, style, color | `line ‖ style ‖ color` |
| `list-style` | type, position, image | `type ‖ position ‖ image` (a lone `none` sets type and image) |
| `transition` | property, duration, timing function, delay | items#: `property ‖ duration ‖ easing ‖ delay` (first time is the duration) |
| `animation` | name, duration, timing function, delay, iteration count, direction, fill mode, play state | items# |

### Stencil extensions

Properties prefixed `-stencil-` drive native effects that CSS has no word for. They are Tern's engine features, not
web standards; Tern's own sheets use only `-stencil-time` and `-stencil-particles` today.

| Property | Values | Initial | Inherited | Animates | Effect |
| --- | --- | --- | --- | --- | --- |
| `-stencil-caret-animation` | `auto` `blink` `breathe` `steady` \| `caret(<on>, <off>, <fade>)` (times) | `auto` | yes | yes | Text caret blink in editable fields. Reduced motion forces `steady`. |
| `-stencil-shape` | `none` \| `shape-union(<smoothness>, round-rect(<x> <y> <w> <h> / <radius> [/ <exponent 2–8>])#)` | `none` | no | yes | Paints the background as a smooth union of rounded rectangles. |
| `-stencil-progress` | `<number>` | `1` | no | yes | Drives `reveal` (0 hidden, 1 shown). Animate it with `@keyframes`. |
| `-stencil-time` | `<time>` | `0s` | no | yes | A clock for particles and other native effects; animate it with `@keyframes`. |
| `-stencil-text-effect` | `none` `reveal` `morph` `numeric` | `none` | no | no | Per-glyph text motion. `reveal` animates glyphs in as `-stencil-progress` goes 0→1; `morph` animates any text replacement; `numeric` animates changed digits. |
| `-stencil-text-stagger` | `<number>` ≥ 0 | `0` | no | yes | How much later each glyph starts than the one before it (0: all at once). |
| `-stencil-text-offset` | `<length> <length>` | `0 0` | no | yes | Where glyphs start from (x y), relative to their place. |
| `-stencil-text-scale` | `<number> <number>` | `1 1` | no | yes | Glyph start scale (x y). |
| `-stencil-text-blur` | `<length>` ≥ 0 | `0` | no | yes | Glyph start blur radius. |
| `-stencil-text-duration` | `<time>` ≥ 0 | `300ms` | no | yes | Duration of `morph` and `numeric` replacements. |
| `-stencil-snapshot-transition` | `none` `fade` `blur` `wipe-left` `wipe-right` `wipe-up` `wipe-down` `genie` `poof` | `none` | no | no | Exit effect played when the host captures a removed element. Tern triggers it; a plugin has no way to. |
| `-stencil-snapshot-duration` | `<time>` ≥ 0 | `300ms` | no | yes | Duration of that exit. |
| `-stencil-snapshot-target` | `<length>{4}` (x y w h) | `0 0 0 0` | no | yes | Where `genie` collapses to. |
| `-stencil-background-extension` | `none` `mirror` | `none` | no | no | Extends the background by mirroring. |
| `-stencil-particles` | `none` \| `particles(poof\|sparks\|confetti, <seed>, <count> [, <lifetime>] [, <gravity>])` | `none` | no | yes | Seeded particle burst painted in the element, sampled at `-stencil-time`. Defaults: lifetime 1s, gravity 120. |
| `-stencil-follow` | `none` \| `follow(<frequency> <damping> <response>)` | `none` | no | yes | Spring-follows `-stencil-follow-target` instead of jumping to it. |
| `-stencil-follow-target` | `<length> <length>` | `0 0` | no | yes | Translation the follower moves toward (x y). |
| `-stencil-squash` | `<number>` 0–0.15 | `0` | no | yes | Squash and stretch from the follower's acceleration. |

```css
.my-answer {
	-stencil-text-effect: reveal;
	-stencil-text-offset: 0 8px;
	-stencil-text-blur: 4px;
	-stencil-text-stagger: .025;
	animation: my-resolve 500ms ease-out both;
}
@keyframes my-resolve { from { -stencil-progress: 0 } to { -stencil-progress: 1 } }
```

### Layout

Layout supports block (with margin collapsing), inline formatting (text, `inline`, `inline-block`), flex, grid,
tables, list items and absolute, fixed and sticky positioning.

| `display` | Lays out as |
| --- | --- |
| `block`, `list-item`, `table-cell`, `-webkit-box` | Block container (`-webkit-box` in its vertical, line-clamp form) |
| `flow-root` | Block container that starts a new formatting context |
| `inline` | Inline content of the nearest block |
| `inline-block`, `inline-flex`, `inline-grid`, `-webkit-inline-box` | Atomic inline box |
| `flex`, `grid` | Flex / grid container |
| `table`, `table-row`, `table-row-group`, `table-header-group` | Table (automatic column layout) |
| `contents` | No box; children take its place |
| `none` | Not rendered |

The root, flex and grid items, and absolutely or fixed positioned boxes are blockified (`inline` → `block`,
`inline-flex` → `flex`, …). `position: sticky` applies its insets at paint time.

Grid places items with `grid-template-columns` / `-rows` and `grid-column` / `grid-row` line numbers and spans;
unplaced items flow into the next free cell, row by row:

```css
.board {
	display: grid;
	grid-template-columns: 120px repeat(2, minmax(0, 1fr));
	gap: 6px;
}
.board > div { padding: 8px; border-radius: 6px; background: rgb(from var(--accent) r g b / 14%); }
.board .tall { grid-row: span 2; }
.board .wide { grid-column: 2 / span 2; }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/styles-css-grid.light.png" srcset="../figures/styles-css-grid.light.png 2x" alt="A three-column grid: a fixed 120 px column holding a cell two rows tall, two equal 1fr cells beside it, and a cell spanning both fr columns below them">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/styles-css-grid.dark.png" srcset="../figures/styles-css-grid.dark.png 2x" alt="A three-column grid: a fixed 120 px column holding a cell two rows tall, two equal 1fr cells beside it, and a cell spanning both fr columns below them">
</figure>

## Selectors

| Selector | Supported |
| --- | --- |
| Type `div`, universal `*`, class `.a`, id `#a` | Yes. Type names are case-insensitive, classes and ids are not. |
| `[attr]` `[attr=v]` `[attr~=v]` `[attr\|=v]` `[attr^=v]` `[attr$=v]` `[attr*=v]` | Yes, with the `i` (case-insensitive) or `s` flag |
| Descendant (space), child `>`, next sibling `+` | Yes |
| Subsequent sibling `~`, column `\|\|`, namespaces `ns\|a` | No |
| Selector lists `a, b` | Yes. One invalid selector drops the whole rule. |
| `&` | In nested rules (see [Rules and nesting](#rules-and-nesting)) |

Specificity follows Selectors 4.

### Pseudo-classes

| Pseudo-class | Matches |
| --- | --- |
| `:hover`, `:active` | Under the pointer / being pressed |
| `:focus`, `:focus-visible`, `:focus-within` | Keyboard focus |
| `:checked`, `:disabled` | The element has a `checked` / `disabled` attribute (attribute test, like `[checked]`) |
| `:first-child`, `:last-child`, `:only-child` | Position among siblings |
| `:first-of-type`, `:last-of-type` | Position among same-tag siblings |
| `:nth-child(An+B [of S])`, `:nth-last-child(An+B [of S])` | Counted position; `of S` filters the siblings |
| `:nth-of-type(An+B)`, `:nth-last-of-type(An+B)` | Counted position among same-tag siblings |
| `:root` | The document root (never inside a scoped sheet) |
| `:empty` | No child elements or text |
| `:not(S#)`, `:is(S#)`, `:where(S#)` | `:where` adds no specificity |

The arguments of `:not()`, `:is()`, `:where()` and `of S` are compound selectors only: `:not(.a.b)` works,
`:not(.a .b)` and `:is(.a > .b)` do not. Everything else (`:has()`, `:enabled`, `:link`, `:visited`, `:target`,
`:placeholder-shown`, `:read-only`, …) is an unsupported pseudo-class.

### Pseudo-elements

| Pseudo-element | Notes |
| --- | --- |
| `::before`, `::after` (also `:before`, `:after`) | Generated box when `content` is set; not on text fields, `img` or `svg` |
| `::marker` | List markers of `display: list-item` with a `list-style-type` other than `none` |
| `::placeholder` | Text field placeholder |
| `::selection` | Selected text; only its colors apply |
| `::-webkit-scrollbar` | Only `display: none` (hides the scrollbar) |

A pseudo-element must end the selector, and cannot appear inside `:is()`/`:not()`/`:where()`.

## At-rules

### `@media`

```css
@media (max-width: 720px) and (prefers-reduced-motion: reduce) { … }
```

| Feature | Values |
| --- | --- |
| `max-width`, `max-height` | `px` only; compares to the window's size (inclusive) |
| `prefers-reduced-motion` | `reduce` |
| `prefers-reduced-transparency` | `reduce`, `no-preference` |
| `prefers-contrast` | `more`, `no-preference` |

Features join with `and`; the words `screen`, `all` and `only` are allowed and ignored. Nested `@media` blocks combine
with their parents. Anything else is an error that drops the block: `min-width`, `min-height`, range syntax
(`width < 600px`), `prefers-color-scheme`, `orientation`, `hover`, `not`, `or`, comma lists and media types such as
`print`. For light and dark, use `light-dark()` or the theme variables ([CSS variables](variables.md)).

### `@keyframes`

`@keyframes name { from {…} 50%, 70% {…} to {…} }`. Offsets are `from`, `to` and percentages 0–100%. A keyframe may set
`animation-timing-function` for the segment that follows it. The last `@keyframes` with a name wins. Names are global
across sheets (except in scoped sheets), so prefix yours.

### `@font-face`

Parsed for errors and then ignored: plugins cannot load fonts. It needs `font-family` and `src`; `font-weight`,
`font-display`, `font-style`, `font-stretch`, `unicode-range` and `font-feature-settings` descriptors are accepted.

### Everything else

`@import`, `@layer`, `@supports`, `@container`, `@property`, `@namespace`, `@page`, `@scope`, `@starting-style` and
`@counter-style` are rejected with `unsupported at-rule`.

## Transitions and animations

Transitions follow CSS Transitions (with Chromium's reversing behavior); `@keyframes` animations follow CSS
Animations. A transition starts when a property in `transition-property` changes value through a style change (a
class toggled by your view, `:hover`, …). `transition-property: all` covers every property whose "Animates" column
says yes. Naming a property that does not animate does nothing; naming an unknown property is accepted and ignored.

Animations interpolate the "Animates: yes" properties (lengths, colors, numbers, shadows, transforms, filters, …).
Keyword properties (`display`, `visibility`, `position`, …) and custom properties switch discretely; so does a pair
of values that cannot interpolate.

Your transitions and animations do not turn themselves off. Respect the user's setting with
`@media (prefers-reduced-motion: reduce) { … }`. The caret already does.

## Scoped sheets

Sheets that a TSP program ships with its surface are confined to that surface. Plugin sheets are not scoped. In a
scoped sheet:

- Every selector gets a leading `[data-scope="<scope>"]` ancestor (no extra specificity), so rules match only inside
  the surface and `:root` never matches.
- Its own `@keyframes` are private: `animation-name` declarations in the sheet refer to its own copy; other names stay
  global.
- Declarations that reach outside the surface are dropped with an error: any `url()` (images, masks, filters, SVG
  paint) and `position: fixed`, also inside `@keyframes`.

## Coming from the web

- No `rem`, `ch`, `ex`, `lh`, `vmin`, `vmax`, dynamic viewport or absolute units: use `px`, `em`, `%`, `vw`, `vh`.
- No `~` combinator and no `:has()`. Selector arguments are compound selectors only.
- `:checked` and `:disabled` test attributes; there is no `:enabled`, `:link`, `:visited`, `:target` or form-state
  pseudo-class beyond those two.
- `@media` knows only `max-width`, `max-height` (px) and three preference features. No `min-width`, no
  `prefers-color-scheme`: use `light-dark()`.
- No `@import`, `@layer`, `@supports`, `@container`, `@property`, `@scope` or `@starting-style`. `@font-face` is ignored.
- No `revert`/`revert-layer`; `all` takes only `inherit`, `initial`, `unset`.
- Missing properties include `text-shadow`, `text-indent`, `word-spacing`, `aspect-ratio`, `object-position`,
  `border-spacing`, `grid-template-areas`, `grid-auto-*`, `grid-area`, `grid-column-start` and
  the other line longhands, `place-self`, `float`, `clear`, `background-attachment` (the `background` shorthand
  drops its keywords), `font-variant` (except `font-variant-numeric`), `font-feature-settings`,
  `text-underline-offset`, `resize`, `accent-color`, `appearance`, `counter-*`, `quotes`, `transition-behavior`,
  `animation-composition`, and every logical property (`margin-inline`, `padding-block`, `inset-inline-start`, …).
  Using them logs `unknown property`.
- No `fit-content` sizing keyword, no `repeat(auto-fill | auto-fit, …)`, no named grid lines, no three-value
  positions, no `linear()` easing, no math beyond `calc()`, `min()`, `max()` and `clamp()`.
- Colors: no `hwb()`, `lab()`, `lch()` or `color()` functions, no system colors. `color-mix()` and relative colors
  work.
- No `conic-gradient()`; `cursor` takes no `url()`; `clip-path` takes only `inset()`.
- `::-webkit-scrollbar` only hides the scrollbar; `::selection` only takes colors.
- Transitions and animations don't skip themselves under reduced motion; add the media query.
