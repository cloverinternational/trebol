# Tool, Agent and Task Kinds

These five kinds draw work in progress and settings as live data. They were
designed for two programs: omp (the coding agent) draws its tool calls, subagents,
todo list and `/settings` page with `tool`, `agent`, `checklist` and `prefs`, and
Tern itself draws a shell command's lens output in a `block`. Every kind renders
in a plugin view too, and this page says what works there. Reach for them when your
plugin shows the same shapes: a running step with a status and an output body
(`tool`), a worker with live stats (`agent`), a phased task list (`checklist`), or a
settings page (`prefs`). You don't build `block` yourself: Tern wraps your lens view
in one.

| Kind | Builder | Draws |
| --- | --- | --- |
| [`tool`](#tool) | `tern.ui.node("tool", …)` | One step: a data head (icon, verb, target, meta, status, timer) over a framed, collapsible body |
| [`agent`](#agent) | `tern.ui.node("agent", …)` | One worker row with live status and stats, and expandable content |
| [`checklist`](#checklist) | `tern.ui.node("checklist", …)` | A phased todo list, a dock pill with a popover, or a "still open" reminder |
| [`block`](#block) | made by Tern around a lens view | A command's output: the lens view or the raw output, a Native/Raw toggle, Copy |
| [`prefs`](#prefs) | `tern.ui.node("prefs", …)` | A full settings page or a settings sheet, driven by your data and your keys |

None of these kinds has a `tern.ui` builder; use `tern.ui.node(kind, props,
children)` (see [UI Builders](../reference/ui.md)). Each node is a
`<div class="sf sf-<kind>" data-id="<id>">` and takes the common props (`role`,
`tone`, `hidden`, `actions`, …) described in [Elements](index.md), with one
exception: `tool` uses `title` as its head verb, not as a tooltip.

Their sheets are built in and load for every surface: `omp-tools.css` (`tool`,
`agent`, `checklist`), `surface-lens.css` (`block`), the kit's `prefs.css` plus
`omp-prefs.css` (`prefs`). Stable hooks are `.sf-<kind>`, `[data-id]`,
`[data-role]`, `[data-tone]`, `[data-state]` and region `[data-surface]`. The other
classes listed below are Tern's inner structure: they are documented so you can
target them, but they are **inner, may change between versions**.

## `tool`

One step of work: a head that Tern draws from data, and a body made of your
children. omp sends one per tool call (`bash`, `read`, `edit`, …); in a plugin it fits
a deploy step, a query, a build stage, anything with a verb, a target, a status and
output.

The head reads, left to right: a status bar on the left edge, an icon, the `title`
verb, the `target`, `meta` facts, badges, a flexible gap, a `note`, an `exit N` chip,
a timer, a status glyph, a chevron and hover action buttons. The body holds the
children in order. Whenever a visible child's kind differs from the visible child
before it (code, then output, then a table), the child gets `.sf-tool-hr` and the
sheet draws a hairline above it. Nothing in the body draws a second frame: nested
`card` and `tool` children lose their ring and tint and draw as borderless
sections (a nested card also hides its head chips), and `code` and `diff` children
lose their background and frame (a code block also hides its head), so a step
never shows a frame inside a frame.

**Frame.** `frame: "card"` (the default) draws one ring with a faint tint while
`running`/`pending` and a red tint on `error`. `frame: "inline"` drops the ring,
the tint and the status bar: a head line plus the body, indented behind a
hairline.

**Status.** `status` is one of `pending`, `running`, `done`, `error`,
`cancelled`; anything else reads as `pending`. `running` shows a spinning ring as the
glyph and a steady left bar; `error` shows an x-circle and a red bar; `cancelled` a
slashed circle; `done` and `pending` no glyph.

**Timer.** While `running` or `pending`, `age` (ms already elapsed when sent)
starts a live timer: it counts up from `age` plus the time since `age` last
arrived, so a patch that leaves `age` alone does not reset it. Otherwise the timer
shows `took`, else `age`, frozen. A frozen time under one second gets `.fast`
(hidden until the head is hovered). No `age`/`took`: no timer.

```lua
local ui = tern.ui

ui.node("col", { gap = "sm" }, {
	ui.node("tool", { name = "bash", title = "Deploy", status = "pending",
		target = "kubectl apply -f k8s/web.yaml", targetKind = "command",
		badges = { { text = "prod", tone = "info" } } }),
	ui.node("tool", { name = "bash", title = "Build", status = "running", age = 4200,
		target = "cargo build --release 2>&1 | tee build.log", targetKind = "command" }, {
		ui.node("ansi", { text = "Compiling stencil-css v0.1.0\n…" }),
	}),
	ui.node("tool", { name = "edit", title = "Edit", status = "done", took = 640,
		target = "src/deploy/plan.rs:13-36", targetKind = "path", meta = { "+8 −1" } }),
	ui.node("tool", { name = "bash", title = "Test", status = "error", took = 3100,
		exit = 101, note = "2 failed",
		target = "cargo test -p deploy", targetKind = "command" }, {
		ui.node("ansi", { text = "test plan::rollback ... \27[31mFAILED\27[0m\n…" }),
	}),
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-work-tool.light.png" srcset="../figures/elements-work-tool.light.png 2x" alt="Four tool steps: a pending Deploy with a prod badge, a running Build with a spinner, a live timer and its output, a done Edit of a path with a +8 −1 diff stat, and a failed Test with a red tint and bar, a 2 failed note, an exit 101 chip and an x-circle">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-work-tool.dark.png" srcset="../figures/elements-work-tool.dark.png 2x" alt="Four tool steps: a pending Deploy with a prod badge, a running Build with a spinner, a live timer and its output, a done Edit of a path with a +8 −1 diff stat, and a failed Test with a red tint and bar, a 2 failed note, an exit 101 chip and an x-circle">
<figcaption>Pending, running, done and error. The Edit's 640 ms is under a second, so its timer waits for a hover.</figcaption>
</figure>

**Target.** `targetKind` decides how a string `target` is drawn:

| `targetKind` | Drawn as |
| --- | --- |
| `command` | One shell line split into runs: `.cmd` (program words), `.flag` (`-x`), `.str` (quoted strings), `.var` (`$X`), `.op` (`|`, `&&`, `;`, `>`, …), plain text for the rest. Ellipsis while collapsed, wraps when expanded. |
| `path` | `.dir` (the directory, dim), `.name` (the file, strong), `.ln` (a `:12` / `:13-36` suffix, quiet) |
| `pattern`, `query` | The text between two `.q` curly quotes |
| `text` (default) | The text or spans as given |

Spans (a table, not a string) are always drawn as spans. With `href` on the node,
the target's tooltip names the link and ⌘-click anywhere on the tool opens it.

**Meta.** Each `meta` entry is one `.sf-tool-meta` span. In a plain string, words
`+N` are wrapped in `.add` (the added color) and `-N` / `−N` in `.del` (the removed
color), so `"+8 −1"` reads like a diff stat.

**Collapse.** `collapsible: true` makes the head a button (Enter or Space flips it;
a plain click flips it, a ⌘-click doesn't). The state is local and remembered by
`key` among the node's siblings (else by id), like a card's, not surface-wide.
Deleting and adding a node with a new id and the same key under the same parent
preserves the fold; the same key under another parent has independent state.
`collapsed` sets the initial state; changing the
prop later resets the remembered state to it. While collapsed:

- with `preview: { lines = N }` the body is clamped to its first N lines under a
  bottom fade, with a "`K more lines · Show all ⌃O`" button below;
- with `preview: { tail = N }` the body is clamped to its last N lines under a top
  fade, with "`K earlier lines · Show all ⌃O`" (the tail wins when both are given);
- with no preview the body hides.

Lines are drawn lines (a wrapped line counts as many), measured from the body's
height. The clamp only applies when the body is taller than the preview. The
Show all button sits below the clamped body for `lines` and between the head and
the body for `tail`; it flips the tool open. The `⌃O` keycap is a label only: keys
reach your block's `key` handler, not the tool.

```lua
ui.node("tool", {
	name = "bash", title = "Deploy", status = "done", took = 12400,
	target = "kubectl rollout status deploy/web", targetKind = "command",
	collapsible = true, collapsed = true, preview = { tail = 3 },
	tools = { { id = "copy", label = "Copy" }, { id = "rerun", label = "Rerun" } },
}, {
	ui.node("ansi", { text = rollout_log }), -- six lines
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-work-tool-preview.light.png" srcset="../figures/elements-work-tool-preview.light.png 2x" alt="A collapsed tool with a tail preview: the head, a '3 earlier lines · Show all ⌃O' button, then the last three output lines under a top fade">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-work-tool-preview.dark.png" srcset="../figures/elements-work-tool-preview.dark.png 2x" alt="A collapsed tool with a tail preview: the head, a '3 earlier lines · Show all ⌃O' button, then the last three output lines under a top fade">
<figcaption>Collapsed with <code>preview = { tail = 3 }</code>. The chevron and the Copy and Rerun buttons show on hover.</figcaption>
</figure>

**Fold.** With Tern's *Fold tool calls* setting on (off by default), two or more
consecutive work blocks among `main`'s children (`tool` nodes, and omp's tool cards
and thinking-only messages) go under one `div.sf-work-head` disclosure reading
"Worked for 12.3s · Deploy ×2 · Test": the summed `took`, then each `title` (else
`name`) with its count. A run that another block follows starts folded; a run
still growing at the end of `main` starts open. The blocks of a run get `.sf-work`,
folded ones `.sf-folded`. Nested tools never fold.

**Actions.** `tools` lists buttons shown in the head on hover or keyboard focus:
`{ id, label, keys? }`, where `keys` is a list of key names drawn as keycaps inside
the button. A click runs `id` as an action on the tool node: the built-ins
(`toggle`, `copy`, `open`, `select`, `activate`, `zoom`) do what they do on any node
(see [Elements](index.md)); any other id sends `action`.

**Build it:** `tern.ui.node("tool", { … }, { …body })`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | `""` | Tool name; picks the icon by the `omp.tool.<name>` role table (`bash`/`shell` terminal, `read` doc, `edit` pen, `write` file-plus, `grep`/`glob`/`search` search, `find` sparkle, `ls` folder, `web`/`fetch`/`browser` globe, `todo` list-checks, `task` users, `eval` code, `python`, `lsp` braces, `proc` activity, …). Any other name gets the plug icon. |
| `title` | text | `""` | The verb ("Deploy", "Query"). Also the head's accessible name, with the target and status. Not a tooltip here. |
| `target` | text | none | The primary argument, mono. |
| `targetKind` | `"command"` \| `"path"` \| `"pattern"` \| `"query"` \| `"text"` | `"text"` | How a string `target` is drawn (table above). Also set as `data-tk` on the node and as a class on `.sf-tool-target`. |
| `href` | string | none | Link of the tool: ⌘-click opens it; shown in the target's tooltip. |
| `meta` | array of text | `[]` | Short facts after the target. |
| `badges` | array of `{ text, tone?, title? }` | `[]` | `.sf-badge` chips in the head; `tone` sets `data-tone`, `title` a tooltip. |
| `note` | text | none | A short state note ("timed out", "partial") before the timer. |
| `exit` | number | none | A non-zero code shows an `exit N` chip (`.sf-chip.st-error.sf-tool-exit`). |
| `status` | `"pending"` \| `"running"` \| `"done"` \| `"error"` \| `"cancelled"` | `"pending"` | State: class `st-<status>`, glyph, tint, timer mode. |
| `age` | number (ms) | none | Elapsed when sent; live timer while running/pending, frozen fallback after. |
| `took` | number (ms) | none | Final duration once settled. |
| `intent` | string | none | Tooltip of the head. |
| `frame` | `"card"` \| `"inline"` | `"card"` | Ring or no ring. |
| `collapsible` | boolean | `false` | Head toggles the body. |
| `collapsed` | boolean | none | Initial collapse state (only with `collapsible`). |
| `preview` | `{ lines = N }` \| `{ tail = N }` | none | Clamp of the collapsed body. |
| `tools` | array of `{ id, label?, keys? }` | `[]` | Hover action buttons. |
| `key` | string | node id | Identity among siblings; collapse is remembered by this key under the same parent. |

**Children:** drawn in order in `.sf-tool-body` (any kinds). Nested `card` and
`tool` children draw unframed.

**Events:** `toggle { id, collapsed, key? }` when the user flips a collapsible tool;
`action { id, act, mods? }` from an action button whose id is not a built-in. Plus the
common `actions` on the node.

**Styling:**

```html
<div class="sf sf-tool card st-running collapsible [collapsed] [nopreview] [clamped] [tail] [inline]"
	data-id="…" data-tk="command">
	<i class="sf-tool-bar"></i>
	<div class="sf-tool-head" role="button" tabindex="0" aria-expanded="true">
		<span class="sf-tool-ic"><!-- icon --></span>
		<span class="sf-tool-line">
			<span class="sf-tool-title">Deploy</span>
			<span class="sf-tool-target command"><span class="cmd">kubectl</span> apply <span class="flag">-f</span> …</span>
			<span class="sf-tool-meta"><span class="add">+8</span> <span class="del">−1</span></span>
			<span class="sf-badge" data-tone="info">prod</span>
			<span class="sf-tool-sp"></span>
			<span class="sf-tool-note">partial</span>
			<span class="sf-chip st-error sf-tool-exit">exit 1</span>
		</span>
		<span class="sf-tool-time [fast]" role="timer">1.2s</span>
		<span class="sf-tool-st"><i class="sf-tool-spin"></i></span>
		<span class="sf-chev"><!-- chevron --></span>
		<span class="sf-tool-acts"><button class="sf-tool-act">Copy<span class="kbd">⌘C</span></button></span>
	</div>
	<div class="sf-tool-body"><!-- children; a child whose kind changes gets .sf-tool-hr --></div>
	<button class="sf-tool-more"><span class="n">12 more lines</span><span class="dot">·</span>Show all<span class="kbd">⌃O</span></button>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-tool` |
| Framed / unframed | `.sf-tool.card` / `.sf-tool.inline` |
| A status | `.sf-tool.st-pending`, `.st-running`, `.st-done`, `.st-error`, `.st-cancelled` |
| Target kind | `.sf-tool[data-tk='path']` |
| Collapse states | `.sf-tool.collapsible`, `.collapsed`, `.nopreview` (collapsed without preview), `.clamped` (preview clamp active), `.tail` (tail preview) |
| Left status bar | `.sf-tool-bar` (inner, may change) |
| Head, icon, line | `.sf-tool-head`, `.sf-tool-ic`, `.sf-tool-line` (inner, may change) |
| Verb, target, meta | `.sf-tool-title`, `.sf-tool-target.<kind>` with `.cmd .flag .str .var .op` / `.dir .name .ln` / `.q`, `.sf-tool-meta .add` / `.del` (inner, may change) |
| Note, exit, timer, glyph | `.sf-tool-note`, `.sf-tool-exit`, `.sf-tool-time` (`.fast`), `.sf-tool-st`, `.sf-tool-spin` (inner, may change) |
| Chevron | `.sf-tool-head > .sf-chev` (inner, may change) |
| Action buttons | `.sf-tool-acts`, `.sf-tool-act`, `.sf-tool-act .kbd` (inner, may change) |
| Body, divider | `.sf-tool-body`, `.sf-tool-body > .sf-tool-hr` (inner, may change) |
| Show all button | `.sf-tool-more` with `.n`, `.dot`, `.kbd` (inner, may change) |

Variables: the clamp height is set inline as `--sf-clamp` on the node while
`.clamped`. The tints read `--sf-tint-pending` and `--sf-tint-error` when the
program defines them, else `--live` / `--sf-bad`; `--sf-run-a` is the running tint's
alpha (0.04 dark, 0.05 light). Colors follow omp's palette first:
`--sf-p-toolTitle`, `--sf-p-toolDiffAdded`, `--sf-p-toolDiffRemoved`,
`--sf-p-syntaxFunction`/`Keyword`/`String`/`Variable`/`Operator`, falling back to
Tern's (see [CSS Variables](../styles/variables.md)). The spinner, bar and head
motion stop under reduced motion and in still views (`.sf-still`).

```lua
local ui = tern.ui

local function step(s)
	return ui.node("tool", {
		key = "deploy." .. s.env,
		name = "bash",
		title = "Deploy",
		target = "kubectl apply -f " .. s.file,
		targetKind = "command",
		badges = { { text = s.env, tone = "info" } },
		status = s.status, -- "running", "done", "error"
		age = s.status == "running" and s.elapsed or nil,
		took = s.took,
		exit = s.exit,
		collapsible = true,
		collapsed = s.status == "done",
		preview = { tail = 6 },
		tools = { { id = "copy", label = "Copy" }, { id = "rerun", label = "Rerun" } },
	}, {
		ui.node("ansi", { text = s.output }),
	})
end
```

A click on Rerun sends `action { id = <tool id>, act = "rerun" }` to your block's
`event`.

## `agent`

One worker as a row: a status glyph, its name, badges, a one-line task, and
right-aligned stats (model, tool calls, requests, progress, context meter or tokens,
cost, timer). A second line shows what it runs now (tool icon, tool name, a
shimmering intent and the tool's own timer) or a retry countdown. Children are its
expanded content. omp sends one per subagent; in a plugin it fits any job or worker
pool: CI runners, crawlers, sync workers.

**Status.** `status` is one of `pending`, `running`, `done`, `failed`, `aborted`,
`idle`, `parked` (anything else reads as `pending`). The glyph is a live pulse
(`running`), a check (`done`), an x (`failed`), a slash (`aborted`), or a hollow ring
(the rest).

**Stats.** Read from `stats`; each part shows only when set:

| Field | Drawn as |
| --- | --- |
| `model` (node prop) | `.model` chip with the last `/` segment of the name; the full name as tooltip. With `thinking` (a palette token such as `thinkingLow`), a dot colored `var(--sf-p-<thinking>, var(--t4))`. |
| `stats.tools` | `.tools`: wrench icon and the count (when above 0) |
| `stats.requests` | `.req`: `N req` (when above 0) |
| `stats.done` | `.done`: a small ring and `N%` (0–1, rounded), only while `running` |
| `stats.context` | `.sf-agent-meter`: a bar of the fraction (0–1, or a percent above 1), `.warn` at 75%, `.bad` at 90%; tooltip and label `contextLabel` or `N% context` |
| `stats.tokens` | `.tok`: compact count (`12K`, `1.2M`), only when `context` is absent |
| `stats.cost` | `.cost`: `$0.42`, or `<$0.01` (when above 0) |
| `stats.age` / `stats.took` | `.time`: live timer from `age` while `running`/`pending`; otherwise frozen `took` (else `age`) |

Like a `tool`'s `age`, `stats.age`, `tool.age` and `retry.age` count on from the
time they arrived, so a patch of other props leaves them running. Because they sit
inside an object, `stats` (or `tool`, `retry`) arriving again with the same `age`,
say to update `tools`, also leaves the count running; a different `age` starts it
over from that value.

**Line 2.** With `retry` set it shows `↻ retry A/M in <countdown>` (counting down
`delay - age` ms), with `error` as tooltip. Otherwise, while `running` with `tool`
set, it shows the tool's icon (same table as [`tool`](#tool)), its name, its intent
(spans get the `shimmer` effect unless they set their own) and a live timer from
`tool.age`. The line hides when empty.

**Collapse.** As with `tool`: `collapsible` makes the row a button (click,
Enter, Space; ⌘-click doesn't flip), the state is local and keyed by `key` among siblings (else by id),
`collapsed` sets it, and `.collapsed` hides the children.

**Depth.** `depth` (0–6) sets `--sf-depth` on the node; the sheet indents the row
by `depth × 22px`, for a tree of workers drawn as siblings.

```lua
ui.node("col", { gap = "xs" }, {
	ui.node("agent", { name = "runner-3", agent = "linux", task = "Build and test main",
		status = "running", model = "anthropic/opus", thinking = "thinkingHigh",
		stats = { tools = 14, done = 0.4, context = 0.78, cost = 0.42, age = 72000 },
		tool = { name = "bash", intent = "Running the test suite", age = 8000 } }),
	ui.node("agent", { name = "runner-4", agent = "linux", task = "Lint the workspace",
		status = "done", stats = { tools = 6, tokens = 19400, cost = 0.08, took = 41000 } }),
	ui.node("agent", { name = "runner-5", agent = "macos", task = "Sign the app bundle",
		status = "failed", badges = { { text = "flaky", tone = "warning" } },
		stats = { tools = 3, took = 12000 } }),
	ui.node("agent", { name = "crawler-1", task = "Fetch the changelog", status = "running",
		depth = 1, stats = { requests = 2, age = 5000 },
		retry = { attempt = 2, max = 5, delay = 30000, age = 12000, error = "429 Too Many Requests" } }),
	ui.node("agent", { name = "runner-6", task = "Waiting for a slot", status = "idle" }),
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-work-agent.light.png" srcset="../figures/elements-work-agent.light.png 2x" alt="Five agent rows: a running runner with a pulse, model chip, tool count, 40% ring, an amber context meter, cost and timer over a line naming the bash step it runs; a done runner with a check, tokens and cost; a failed runner with an x and a flaky badge; an indented crawler counting down a retry; an idle runner with a hollow ring">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-work-agent.dark.png" srcset="../figures/elements-work-agent.dark.png 2x" alt="Five agent rows: a running runner with a pulse, model chip, tool count, 40% ring, an amber context meter, cost and timer over a line naming the bash step it runs; a done runner with a check, tokens and cost; a failed runner with an x and a flaky badge; an indented crawler counting down a retry; an idle runner with a hollow ring">
<figcaption>The context meter turns amber at 75%. The model dot is gray here: this palette defines no <code>thinkingHigh</code>.</figcaption>
</figure>

**Build it:** `tern.ui.node("agent", { … }, { …content })`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | `""` | Display name; with the status, the row's accessible name. |
| `agent` | string | none | Type shown as the first `.sf-badge` (no tone). |
| `badges` | array of `{ text, tone? }` | `[]` | More `.sf-badge` chips. |
| `task` | text | none | One-line task; ellipsized, full text as tooltip. |
| `status` | see above | `"pending"` | Class `st-<status>`, glyph, timer mode. |
| `model` | string | none | Model chip. |
| `thinking` | string | none | Palette token for the model chip's dot. |
| `stats` | `{ tools?, requests?, done?, context?, contextLabel?, tokens?, cost?, age?, took? }` | none | The stats above. Without `stats` there is no timer. |
| `tool` | `{ name, intent?, age? }` | none | The tool running now (line 2, `running` only). |
| `retry` | `{ attempt?, max?, delay?, age?, error? }` | none | Retry countdown on line 2 (wins over `tool`); `attempt`/`max` default to 1. |
| `depth` | integer | `0` | Nesting depth, capped at 6. |
| `collapsible` | boolean | `false` | Row toggles the children. |
| `collapsed` | boolean | none | Initial collapse state. |
| `key` | string | node id | Identity among siblings; collapse is remembered by this key under the same parent. |

**Children:** drawn in order in `.sf-agent-kids` (hidden when there are none, or
while collapsed).

**Events:** `toggle { id, collapsed, key? }` when the user flips a collapsible row.
Plus the common `actions`.

**Styling:**

```html
<div class="sf sf-agent st-running collapsible [collapsed]" data-id="…" style="--sf-depth: 1">
	<div class="sf-agent-row" role="button" tabindex="0" aria-expanded="true">
		<span class="sf-agent-g"><i class="live"></i></span>
		<span class="sf-agent-name">runner-3</span>
		<span class="sf-badge">linux</span>
		<span class="sf-agent-task">Build and test main</span>
		<span class="sf-sp"></span>
		<span class="sf-agent-stats">
			<span class="model"><i class="dot"></i>opus</span>
			<span class="tools"><!-- wrench -->14</span>
			<span class="req">9 req</span>
			<span class="done"><!-- ring -->40%</span>
			<span class="sf-agent-meter warn"><i class="fill"></i></span>
			<span class="cost">$0.42</span>
			<span class="time" role="timer">1m 12s</span>
		</span>
	</div>
	<div class="sf-agent-now">
		<span class="ic"><!-- icon --></span><span class="tn">bash</span>
		<span class="intent">Running tests</span><span class="time">8s</span>
	</div>
	<div class="sf-agent-kids"><!-- children --></div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-agent` |
| A status | `.sf-agent.st-running`, `.st-done`, `.st-failed`, `.st-aborted`, `.st-idle`, `.st-parked`, `.st-pending` |
| Collapse | `.sf-agent.collapsible`, `.sf-agent.collapsed` |
| Row, glyph | `.sf-agent-row`, `.sf-agent-g` (`.live`, `.hollow`, icon) (inner, may change) |
| Name, task | `.sf-agent-name`, `.sf-agent-task` (inner, may change) |
| Stats | `.sf-agent-stats` with `.model`, `.model .dot`, `.tools`, `.req`, `.done`, `.tok`, `.cost`, `.time` (inner, may change) |
| Context meter | `.sf-agent-meter` (`.warn`, `.bad`), `.sf-agent-meter .fill` (inner, may change) |
| Line 2 | `.sf-agent-now` with `.ic`, `.tn`, `.intent`, `.time`, `.retry` (inner, may change) |
| Content | `.sf-agent-kids` (inner, may change) |

Variables: `--sf-depth` (set per node). The pulse and the meter fill animate,
and stop under reduced motion and in still views.

```lua
local ui = tern.ui

local function worker(w)
	return ui.node("agent", {
		key = "w." .. w.id,
		name = w.id,
		agent = w.pool,
		task = w.job,
		status = w.state, -- "running", "idle", "done", "failed"
		stats = { tools = w.steps, cost = w.cost, age = w.elapsed, took = w.took },
		tool = w.state == "running" and { name = "bash", intent = w.step, age = w.step_age } or nil,
		collapsible = true,
		collapsed = true,
	}, {
		ui.node("md", { text = w.log_summary }),
	})
end
```

## `checklist`

A todo list in phases, drawn from data in one of three presentations. omp uses it
for its todo tool (`full`), the pill above its composer (`hud`) and an end-of-turn
notice (`reminder`). In a plugin it fits a release checklist, a migration plan, any
phased progress.

**Items.** Each item has a `status`: `pending` (a hollow ring), `active` (a
pulsing dot in a ring, text emphasized), `done` (a check, text struck), `dropped`
(a dash, struck, dim) or `blocked` (a warning triangle; its note in the warning
color). Unknown statuses draw as `pending`. A phase's progress counts `done` and
`dropped` items.

**`full`** (default). Each phase is a row with a progress ring, its title and
`done/total`, then its items. A single phase without a title drops its row. A
completed phase folds to its row; `collapsed` on the phase overrides that. A click
(or Enter/Space) on a phase row folds or unfolds it locally, remembered per phase
id while the node lives. Phases without an `id` share one fold.

**`hud`.** A pill button at the right edge: the overall ring, the text of the
first `active` item (else the first `pending`; else "All done" or "Todos") and
`done/total`. A click opens or closes a popover (`.sf-ck-pop`) above the pill
holding the `full` list, and sends `activate { id, item = "hud" }`.

**`reminder`.** A header button: a warning icon, "`N todos still open`" (open
means `pending`, `active` or `blocked`), the `note` and a chevron. A click discloses
the open items only.

Items that turned `done` since the last draw get `.fresh` once: the check scales in
and the strike draws, never again on later redraws. Send updates as new `phases` on
the same node to keep that.

**Build it:** `tern.ui.node("checklist", { mode = …, phases = { … } })`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `phases` | array of phases | `[]` | The list. |
| `phases[].id` | string | `""` | Phase id; keys the local fold. |
| `phases[].title` | text | none | Phase title. |
| `phases[].items` | array of items | `[]` | Items (an item without `id` is skipped). |
| `phases[].collapsed` | boolean | folded when complete | Initial fold. |
| `items[].id` | string | required | Item id; keys the `.fresh` animation. |
| `items[].text` | text | `""` | Item text. |
| `items[].status` | `"pending"` \| `"active"` \| `"done"` \| `"dropped"` \| `"blocked"` | `"pending"` | Item state. |
| `items[].note` | text | none | A line under the item. |
| `mode` | `"full"` \| `"hud"` \| `"reminder"` | `"full"` | Presentation; also a class on the node. |
| `note` | text | none | `reminder` only: text after the count ("reminder 1/3"). |

**Children:** none (ignored).

**Events:** `activate { id, item = "hud" }` when the `hud` pill is clicked. Phase
folds and the reminder disclosure are local and send nothing.

**Styling:**

```html
<!-- full -->
<div class="sf sf-checklist full" data-id="…" role="group" aria-label="Todos, 3 of 7 done">
	<div class="sf-ck-phase [done] [folded]">
		<div class="sf-ck-ph" role="button" tabindex="0" aria-expanded="true">
			<svg class="sf-ring [full]"><circle class="tr"/><circle class="fl"/></svg>
			<span class="t">Ship</span><span class="n">2/3</span>
		</div>
		<div class="sf-ck-items">
			<div class="sf-ck-item st-done [fresh]">
				<span class="sf-ck-g"><!-- check / dash / warn / <i class="dot"> --></span>
				<span class="sf-ck-t">Tag the release</span>
				<div class="sf-ck-note">waiting on CI</div>
			</div>
		</div>
	</div>
</div>
<!-- hud -->
<div class="sf sf-checklist hud [open]">
	<button class="sf-ck-pill" aria-expanded="false"><svg class="sf-ring">…</svg><span class="t">Tag the release</span><span class="n">3/7</span></button>
	<div class="sf-ck-pop [sf-hidden]"><!-- the full list --></div>
</div>
<!-- reminder -->
<div class="sf sf-checklist reminder [open]">
	<div class="sf-ck-rh" role="button" tabindex="0"><span class="ic"><!-- warn --></span><span class="t">4 todos still open</span><span class="n">reminder 1/3</span><span class="sf-chev"></span></div>
	<div class="sf-ck-items"><!-- open items --></div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-checklist` |
| Presentation | `.sf-checklist.full`, `.hud`, `.reminder`; `.open` (popover or reminder open) |
| Phase | `.sf-ck-phase` (`.done`, `.folded`), `.sf-ck-ph` with `.t`, `.n` (inner, may change) |
| Progress ring | `.sf-ring` (`.full` when complete), `.sf-ring .tr`, `.sf-ring .fl` (inner, may change) |
| Items | `.sf-ck-items`, `.sf-ck-item.st-<status>`, `.sf-ck-item.fresh` (inner, may change) |
| Item parts | `.sf-ck-g` (`.dot` when active), `.sf-ck-t`, `.sf-ck-note` (inner, may change) |
| HUD | `.sf-ck-pill` with `.t`, `.n`; `.sf-ck-pop` (inner, may change) |
| Reminder | `.sf-ck-rh` with `.ic`, `.t`, `.n`, `.sf-chev` (inner, may change) |

The ring's fill is a `stroke-dasharray` set inline. The pop, strike, popover and
active-dot motion stop under reduced motion and in still views.

```lua
local ui = tern.ui

local phases = {
	{ id = "build", title = "Build", items = {
		{ id = "b1", text = "Compile", status = "done" },
		{ id = "b2", text = "Test", status = "done" },
	} },
	{ id = "ship", title = "Ship", items = {
		{ id = "s1", text = "Write the changelog", status = "done" },
		{ id = "s2", text = "Tag the release", status = "active" },
		{ id = "s3", text = "Publish", status = "blocked", note = "waiting on approval" },
		{ id = "s4", text = "Announce", status = "pending" },
		{ id = "s5", text = "Update the old docs", status = "dropped" },
	} },
}

ui.node("col", { gap = "md" }, {
	ui.node("checklist", { mode = "full", phases = phases }),
	ui.node("checklist", { mode = "hud", phases = phases }),
	ui.node("checklist", { mode = "reminder", note = "reminder 1/3", phases = phases }),
})
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-work-checklist.light.png" srcset="../figures/elements-work-checklist.light.png 2x" alt="The same todo list three ways: a full list with a folded, complete Build phase and an open Ship phase showing done, active, blocked, pending and dropped items; a HUD pill reading Tag the release 4/7; and a reminder line reading 3 todos still open, reminder 1/3">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-work-checklist.dark.png" srcset="../figures/elements-work-checklist.dark.png 2x" alt="The same todo list three ways: a full list with a folded, complete Build phase and an open Ship phase showing done, active, blocked, pending and dropped items; a HUD pill reading Tag the release 4/7; and a reminder line reading 3 todos still open, reminder 1/3">
<figcaption><code>full</code>, <code>hud</code> and <code>reminder</code> of the same phases. Build is complete, so it folds to its row.</figcaption>
</figure>

## `block`

Tern's command-lens block: one shell command's output, diverted from the terminal
grid and read by a lens. Tern creates it; it is designed for the terminal, not for
plugin views. What you write for a [lens](../reference/api-host.md) is the view
inside it: Tern wraps your view in a `col` with id `native` and inserts it as the
block's first child, before `raw` (an `ansi` node with the captured bytes).

The block shows `native` when there is one, else `raw`. Native/Raw is a local,
per-block choice remembered by `key` among the node's siblings (else by id), not
surface-wide. Deleting and adding a block with a new id and the same key under
the same parent preserves the choice; the same key under another parent has
independent state. Only the shown child is mounted, so
switching redraws the block. The chrome stays quiet so the block reads as command
output:

- a faint 2px left edge: brighter on hover, tinted `--live` while running and
  `--sf-bad` after a failed exit;
- a toolbar at the top right that appears on hover or keyboard focus: the lens
  label (icon plus the program and, for `git`, `cargo`, `docker`, `npm`, `kubectl`,
  … its subcommand, skipping `NAME=value` assignments and wrappers such as `sudo`,
  `env`, `time`, `npx`, `uvx`), with the typed `cmd` as tooltip; the Native/Raw
  segmented control (hidden when there is no native view); a Copy button;
- a muted foot line with an `exit N` badge (non-zero exit, once done) and the
  duration (`took`, once done, over one second). The foot hides when both are
  absent.

Copy runs the `copy` action: it copies the raw output as plain text, as a terminal
of the capture's width shows it.

**Build it:** Tern builds it. Its props, for reference:

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cmd` | string | `""` | The line as typed; the lens label's tooltip. |
| `line` | string | `cmd` | The recognized line; the label is derived from it. |
| `cwd` | string | none | Working directory (used by Tern on restore; not drawn). |
| `lens` | string | `""` | Lens id (`git.log`, `plugin.k8s.get`); `data-role` becomes `lens.<lens>` and picks the icon. Plugin lenses (`lens.plugin.…`) get the terminal icon. |
| `role` | string | `lens.<lens>` | Overrides `data-role`. |
| `state` | `"running"` \| `"done"` | `"done"` | Sets `data-state`; anything but `"running"` is `done`. |
| `exit` | integer | none | Exit status; non-zero (once done) adds `.failed` and the exit badge. |
| `took` | number (ms) | none | Duration in the foot (once done, over 1000 ms). |
| `age` | number (ms) | none | Carried by Tern but not drawn by the block. |
| `key` | string | node id | Identity among siblings; the Native/Raw choice is remembered by this key under the same parent. |

**Children:** `native` (your lens view inside a `col`, absent until the lens has a
view) and `raw` (`ansi`). The raw child is the one with id `raw`, else the last
`ansi` child; the native child is the first other child. Only one is shown.

**Events:** none. Nobody listens to a finished command, so Native/Raw and Copy
are local.

**Styling:** this is where lens authors scope their CSS.

```html
<div class="sf sf-block [failed]" data-id="b" data-role="lens.plugin.k8s.get" data-state="done" data-view="native">
	<div class="sf-block-bar">
		<span class="sf-block-lens" title="kubectl get pods -A">
			<span class="sf-block-ic"><!-- icon --></span><span class="lbl">kubectl get</span>
		</span>
		<div class="sf-block-seg" role="group" aria-label="Output">
			<button class="sf-block-opt on" aria-pressed="true">Native</button>
			<button class="sf-block-opt" aria-pressed="false">Raw</button>
		</div>
		<button class="sf-block-copy" aria-label="Copy output"><!-- icon --></button>
	</div>
	<div class="sf-block-body">
		<div class="sf sf-col" data-id="native"><!-- your lens view --></div>
	</div>
	<div class="sf-block-foot">
		<span class="sf-badge" data-tone="error">exit 1</span><span class="sf-block-took">2.4s</span>
	</div>
</div>
```

| Target | Selector |
| --- | --- |
| Your lens's blocks | `.sf-block[data-role='lens.plugin.<plugin>.<lens>']` |
| Running / finished | `.sf-block[data-state='running']` / `[data-state='done']` |
| Failed exit | `.sf-block.failed` |
| Showing native or raw | `.sf-block[data-view='native']` / `[data-view='raw']` |
| Your view | `.sf-block-body > [data-id='native'] > …`, or your own `role` on your nodes |
| Toolbar | `.sf-block-bar`, `.sf-block-lens`, `.sf-block-ic`, `.sf-block-lens .lbl` (inner, may change) |
| Native/Raw | `.sf-block-seg`, `.sf-block-opt`, `.sf-block-opt.on` (inner, may change) |
| Copy | `.sf-block-copy` (inner, may change) |
| Body | `.sf-block-body` (inner, may change) |
| Foot | `.sf-block-foot`, `.sf-block-foot > .sf-badge`, `.sf-block-took` (inner, may change) |

Two rules in `surface-lens.css` affect lens views: inside a block a card's body is indented
12px (`.sf-block-body .sf-card-body`), and a list with `role = "output"` reads as
output lines (selectable text, no hover, wrapping unless virtual). The body's gap is
`--sf-inner-gap`.

```css
/* A plugin sheet: highlight a failing kubectl lens, and dim it while it runs. */
.sf-block[data-role='lens.plugin.k8s.get'].failed .sf-table {
	box-shadow: inset 2px 0 0 var(--sf-bad);
}
.sf-block[data-role='lens.plugin.k8s.get'][data-state='running'] .sf-table {
	opacity: 0.7;
}
```

You may put a `block` node in your own block view, but it is not useful there: it
draws, but Copy copies an empty string outside a terminal's command block, since the
raw text comes from the block surface.

## `prefs`

A settings page drawn as the kit Preferences page, from your data. omp sends it
for `/settings`. It is the richest kind here: the program owns every setting and
every key, and the page sends each pointer action back as an event; you answer with
new props.

**Where it draws.** In `main` it fills the region's host as a full page: a nav
column (brand, search, page groups), the scrolling document and a Close button at
the top right. Below 760px wide the nav collapses to an icon rail (`.pf.rail`). In
`layer` it is the kit's sheet (`.pf.sheet`): docked at the right edge, `--tv-aside`
wide (440px when the host reserves none), with the close button in the brand row and
the pages as an icon strip. In a terminal's inline surface the host narrows the
transcript beside the sheet (the "aside"); a plugin block is a screen surface, so
nothing narrows beside it there: the sheet sits over the block's content.

**Data model.** The page is `pages` (nav), the current `page`, and `sections`
of rows. Each row has a `control` whose `k` is one of seven kinds.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `title` | string | `"Settings"` | Brand title and the page's accessible name. |
| `pages` | array of `{ id, label?, group?, icon?, disabled?, changed? }` | `[]` | Nav rows. Consecutive pages with the same `group` share a group with that heading. `icon` is an [icon name](data.md#icon) (default `sliders`). `disabled` (a reason string) dims the row and becomes its tooltip; it can't be opened, from its nav row or from its search result heading (marked `.off`, with the same tooltip). `changed` (a count above 0) shows a "N changed from default" count. |
| `page` | string | `""` | Current page id: highlighted in the nav; the header shows `NN · Label` and the label. |
| `lead` | string | none | A paragraph under the page title. |
| `sections` | array of sections | `[]` | The document's sections (see below). |
| `query` | string | `""` | Search text. Non-empty (trimmed): the document shows results, grouped by each section's `page` under a page heading, with the matching words of labels and hints in `<mark>`. Tern does not filter: you send only the matching sections, each with its `page`. |
| `cursor` | integer | none | UTF-16 caret position in the search field; set while your search field has the keys. Without it the field shows the trimmed query, or "Search settings". |
| `focus` | string | none | A row id or section id with the focus ring (`.focus`); the page scrolls it into view (sections to the top, rows to the nearest edge). |
| `editing` | `{ row, option?, draft?, cursor? }` | none | The row you are editing with the keyboard (see Editing). |

A section is `{ id?, title?, page?, rows }`. A section without rows is skipped
(except id `status-line`, see Children). A page with no rows at all shows "Nothing to
set here"; a search with no hits shows "No settings match …".

A row:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Required; the row's `data-row` and the `item` of its events. |
| `label` | string | The label (default the id). |
| `hint` | string | A line under the label. |
| `warning` | string | A warning icon before the label and the text under it (`.warn`). |
| `disabled` | string | A reason: shown under the label and as tooltip; the row dims (`.off`) and its controls do nothing. |
| `changed` | boolean | An accent dot left of the label (tooltip "Changed from default: `defaultLabel`", or just "Changed from default") and a Reset button before the control (not for `action` and `keys` rows, nor disabled ones). |
| `defaultLabel` | string | The default, named in the dot's tooltip. |
| `control` | object | The control, by `k` (next table). |

The seven controls:

| `k` | Fields | Draws | On click |
| --- | --- | --- | --- |
| `switch` | `on` | `.pf-sw` toggle | Flips at once, sends `change { value = bool }` |
| `choice` | `value`, `options` (`{ value, label?, detail? }`), `style` (`"auto"` \| `"segmented"` \| `"menu"`), `mono` | `.pf-seg` segments when `segmented`, or with `auto` when 2–4 options whose labels total 28 characters or fewer; else a `.pf-pick` popup button showing the current label. `detail` is a segment's tooltip or a menu option's second line. | Segment: selects at once, sends `change { value = string }`. Popup: sends `activate`; while you set `editing` on the row it shows the menu; picking an option sends `change { value }`. |
| `number` | `value`, `min`, `max`, `step` (default 1), `unit`, `labels` (`{ ["<n>"] = label }`) | `.pf-step`: − value + | Sends `change { value = number }` with the next value: the next key of `labels` when given, else `value ± step` clamped to `min`/`max`. A button with nowhere to go is disabled. The value shows its `labels` entry, else the number and `unit`. |
| `text` | `value`, `placeholder` (default "Not set"), `secret`, `mono` | `.pf-in`: a field look, not an input | Sends `activate`; while editing it shows `editing.draft` with a caret at `editing.cursor`. `secret` shows dots. |
| `keys` | `keys` (array of chords, each an array of key names) | Keycap groups (`.pf-chord > .kbd`); the row gets `.pf-key` | Nothing (no control action) |
| `multi` | `values`, `options`, `ordered` | Toggle chips (`.pf-chips > .pf-chip`), or with `ordered` a reorderable list (`.pf-order > .pf-oi`: grip, position, label, switch), enabled ones first in `values` order | Sends `change { value = { …enabled values in order } }`. In an ordered list, dragging a grip onto another item moves it before that item (after it when dropped on its lower half), enables it, and sends the new order. |
| `action` | `act` (default `"edit"`), `label` (default "Edit…") | A small button | Sends `action { act, value = row }` |

**Editing.** Keys never reach the page; they reach your block's `key` handler. You
drive keyboard use through props: `focus` moves the ring; `editing = { row }` opens a
choice row's menu (with `option` highlighted, default the current value), puts a
multi row's highlight on `option`, or shows a text row's `draft` with a caret at
`cursor`. Clear `editing` to close.

**Updates.** The document rebuilds only when its structure changes (page, query,
sections, row ids, control kinds and options; a page or query change also scrolls to
the top and replays the arrive motion). Otherwise rows patch in place, so a switch
slides instead of redrawing.

**Children:** placed by `role`. A child with role `omp.prefs.preview.status` goes
after the `status-line` section (and is not drawn while that section isn't shown).
A child with role `omp.prefs.editor`, or any `picker`, goes into `.pf-editor`, a
glass card over the page (for an editor with no native control, or a large choice's
submenu). Anything else goes after the sections in `.pf-extra`.

**Events:** all of them carry `id` = the prefs node's id.

| User does | Event |
| --- | --- |
| Clicks a nav row or a search result page heading | `action { act = "page", value = <page id> }` (nothing for a disabled page, from either) |
| Clicks Close (or the sheet's x) | `action { act = "close" }` |
| Flips a switch, a segment, a menu option, a stepper, a chip, reorders, or presses Reset | `change { item = <row>, value }`: switch `bool`, choice `string`, number `number`, multi `string[]` in order, Reset `null` |
| Clicks a popup button or a text field | `activate { item = <row> }` |
| Clicks an open popup's button again, or clicks anywhere outside an open menu | `action { act = "close", value = <row> }` |
| Points at a menu option | `select { item = "<row>=<value>" }`, once per option (for a live preview) |
| Clicks an `action` button | `action { act = <control.act>, value = <row> }` |
| Clicks a row off its control | `select { item = <row> }` |
| Clicks the page while focus is in a field outside it | `focus` first, then the event above |

The page has no Escape handling of its own: Escape reaches your `key` handler,
where you close the page (or the open editor). All of these events reach a
plugin block's `event`.

**Styling:**

```html
<div class="sf sf-prefs" data-id="…">
	<div class="pf on [rail] [sheet]" aria-label="Settings">
		<nav class="pf-nav">
			<div class="pf-brand"><span class="pf-mark"></span><span class="pf-brand-t">Settings</span><button class="icon-btn pf-close"></button></div>
			<div class="pf-search"><!-- icon --><span class="q [ph]"><span class="pre"></span><span class="pf-caret"></span><span class="post"></span></span></div>
			<div class="pf-groups">
				<div class="nav-group pf-group"><div class="nav-head">General</div>
					<div class="pf-items"><button class="nav-row [on] [off]" data-v="look"><!-- icon --><span class="lbl">Look</span><span class="meta pf-changed">2</span></button></div>
				</div>
			</div>
		</nav>
		<div class="pf-scroll"><div class="pf-doc [arrive]">
			<header class="pf-head [pf-found]"><div class="pf-eyebrow mono">01 · Look</div><h1 class="pf-title">Look</h1><p class="pf-lead">…</p></header>
			<section class="pf-sec" data-sec="theme"><h2 class="pf-sec-t">Theme</h2>
				<div class="pf-rows">
					<div class="pf-row [changed] [warn] [off] [editing] [stack] [focus]" data-row="dark">
						<span class="pf-dot"></span>
						<div class="pf-lbl"><div class="t">Dark mode</div><div class="h">…</div></div>
						<div class="pf-ctl"><button class="pf-reset">Reset</button><button class="pf-sw on" role="switch"><i class="knob"></i></button></div>
					</div>
				</div>
				<div class="pf-preview"></div>
			</section>
			<div class="pf-extra"></div>
		</div></div>
		<div class="pf-top"><button class="btn sm quiet"><span class="kbd">esc</span>Close</button></div>
		<div class="pf-editor [on]"></div>
	</div>
</div>
```

| Target | Selector |
| --- | --- |
| The node | `.sf-prefs`; in the layer, `.sf-layer .sf-prefs` |
| Page, rail, sheet | `.pf`, `.pf.rail`, `.pf.sheet` (kit classes, inner, may change) |
| Nav | `.pf-nav`, `.pf-brand`, `.pf-close`, `.pf-search .q` (`.ph`, `.pf-caret`), `.pf-groups`, `.nav-group`, `.nav-head`, `.nav-row` (`.on`, `.off`), `.pf-changed` (inner, may change) |
| Document | `.pf-scroll`, `.pf-doc` (`.arrive`), `.pf-head` (`.pf-found` for search), `.pf-eyebrow`, `.pf-title`, `.pf-lead`, `.pf-part`, `.pf-part-h` (`.off`), `.pf-part-b`, `.pf-none` (inner, may change) |
| Sections | `.pf-sec[data-sec='<id>']` (`.focus`), `.pf-sec-t`, `.pf-rows`, `.pf-preview`, `.pf-extra`, `.pf-editor.on` (inner, may change) |
| Rows | `.pf-row[data-row='<id>']` with `.changed`, `.warn`, `.off`, `.editing`, `.stack` (multi), `.focus`, `.pf-key` (keys); `.pf-dot`, `.pf-lbl .t`, `.pf-lbl .h`, `.pf-warn`, `.pf-why`, `.pf-ctl`, `.pf-reset`, `mark` (inner, may change) |
| Controls | `.pf-sw` (`.on`, `.sm`, `.knob`); `.pf-seg > button.on`; `.pf-pop`, `.pf-pick`, `.pf-menu` (`.still`), `.mi` (`.cur`, `.sel`, `.two`), `.pf-check`, `.pf-ml .t`, `.pf-ml .d`; `.pf-step`, `.pf-step .v`; `.pf-in` (`.mono`, `.editing`, `.v`, `.ph`, `.secret`); `.pf-chord .kbd`; `.pf-chips`, `.pf-chip` (`.on`, `.sel`); `.pf-order`, `.pf-oi` (`.on`, `.sel`, `.drag`), `.pf-grip`, `.pf-oi .n` (inner, may change) |

Variables: `--tv-aside` (sheet width), `--sf-zoom`, `--pf-room` (set inline on an
open menu: its width budget, so long options wrap inside the row), and the kit's
`--accent`, `--accent-ink`, `--accent-fill`, which follow the program's accent
under "Use program colors" (`.sf-pal`). The page sets its own height to its host.

```lua
local ui = tern.ui

local function settings(state)
	return ui.node("prefs", {
		title = "Deploy settings",
		lead = "How and where your pushes deploy.",
		pages = {
			{ id = "general", label = "General", icon = "sliders" },
			{ id = "targets", label = "Targets", icon = "server", changed = state.changed },
			{ id = "keys", label = "Shortcuts", icon = "keyboard" },
		},
		page = state.page,
		focus = state.focus,
		editing = state.editing,
		sections = {
			{ id = "run", title = "Runs", rows = {
				{ id = "auto", label = "Deploy on push", hint = "Every push to main starts a deploy.",
					control = { k = "switch", on = state.auto } },
				{ id = "env", label = "Environment", changed = state.env ~= "dev", defaultLabel = "Dev",
					control = { k = "choice", value = state.env, options = {
						{ value = "dev", label = "Dev" },
						{ value = "staging", label = "Staging" },
						{ value = "prod", label = "Prod" },
					} } },
				{ id = "jobs", label = "Parallel jobs", control = { k = "number", value = state.jobs, min = 1, max = 8 } },
				{ id = "token", label = "API token", control = { k = "text", value = state.token, secret = true } },
				{ id = "notify", label = "Notify", control = { k = "multi", values = state.notify, options = {
					{ value = "slack", label = "Slack" },
					{ value = "email", label = "Email" },
					{ value = "pager", label = "Pager" },
				} } },
				{ id = "logs", label = "Clear logs", hint = "Deletes the logs of finished runs.",
					control = { k = "action", act = "clear-logs", label = "Clear" } },
			} },
		},
	})
end

-- In the block's event(state, ev, cx):
-- ev.ev == "change" and ev.item == "auto" -> state.auto = ev.value
-- ev.ev == "action" and ev.act == "page"  -> state.page = ev.value
-- ev.ev == "activate" and ev.item == "token" -> state.editing = { row = "token", draft = state.token, cursor = #state.token }
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/elements-work-prefs.light.png" srcset="../figures/elements-work-prefs.light.png 2x" alt="A settings page 560 pixels wide: an icon rail with the brand mark and three page icons, the General page header with its lead, and a Runs card with a switch, a focused Environment row showing a changed dot, Reset and Dev/Staging/Prod segments, a stepper at 4, a hidden token field, Slack and Email chips on and Pager off, and a Clear button">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/elements-work-prefs.dark.png" srcset="../figures/elements-work-prefs.dark.png 2x" alt="A settings page 560 pixels wide: an icon rail with the brand mark and three page icons, the General page header with its lead, and a Runs card with a switch, a focused Environment row showing a changed dot, Reset and Dev/Staging/Prod segments, a stepper at 4, a hidden token field, Slack and Email chips on and Pager off, and a Clear button">
<figcaption>With <code>page = "general"</code>, <code>focus = "env"</code>, <code>env = "prod"</code>, <code>changed = 2</code>. At 560px the nav is an icon rail; the figure caps the page's height, which otherwise fills its host.</figcaption>
</figure>

Text editing then happens in your `key` handler: update `editing.draft` and
`editing.cursor` per key, commit on Enter, clear `editing` on Escape.
