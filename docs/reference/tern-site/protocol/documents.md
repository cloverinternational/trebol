# Documents and Frames

A surface's content is a document: a tree of nodes the program builds and
changes with frames of ops.

## The document

A node is `{"id": string, "k": kind, "p": props, "c": [children]}`. `p` and
`c` are optional.

- Ids are yours: non-empty strings, unique within the surface, and short
  (omp uses a base-36 counter). Keep a component's id stable for its
  lifetime, so Tern keeps its elements, highlighting and folding across
  updates.
- `k` must be a kind of the vocabulary the `hello` reply lists.
- Props are the kind's own plus the props every node takes. The kinds and
  their props are in [Elements](../elements/index.md). A `null` prop is
  dropped, as if absent.
- Text lives in props (`text`, `spans`). Text kinds (`text`, `md`, `code`,
  `ansi`, `math`, `editor`, `input`, `shimmer`, `el`) keep their primary text
  in `text`, which the `text` and `splice` ops address. Nothing inherits font
  metrics from the program.

The root is the surface itself: a `col` whose id is the surface's `id`, which
you can't move or delete. Its children are the
[regions](surfaces.md#regions): nodes you add under the root with the ids
`main`, `dock` and `layer` (usually `col`s). A surface starts with only the
root, so its first frame adds the regions it uses.

## Frames

A frame is `{"sf": surface, "s": seq, "ops": [op…]}`, applied atomically: Tern
draws the document only between frames, so a frame replaces synchronized
output for surfaces. `s` increases with each frame of a surface, and Tern
acknowledges what it drew with `ack` events ([Flow control](operations.md#flow-control)).
Tern doesn't check the order of `s`; it echoes it in `ack` and `error`.

## Frame ops

| Op | Shape | Effect |
| --- | --- | --- |
| `add` | `["add", id, parent, before\|null, node]` | Insert `node` (a whole subtree) under `parent`, before sibling `before` or last when `null`. `id` must equal `node.id`, and `before` is required. If any node of the subtree fails (unknown kind, duplicate id, a limit), none of it is added. |
| `set` | `["set", id, props]` | Merge props shallowly: each key replaces that prop whole. A `null` value deletes a prop. |
| `text` | `["text", id, "append"\|"replace", string]` | Update the primary text of a text kind (`text`, `md`, `code`, `ansi`, `math`, `editor`, `input`, `shimmer`, `el`). `append` to a node without text sets it. `append` is the streaming path: an `md` node re-renders from its last open block on. |
| `splice` | `["splice", id, at, del, string]` | Replace `del` UTF-16 code units at `at` in the primary text (editor edits, large pastes). `at` and `del` are integers with `at + del` within the text, and neither end may split a surrogate pair. |
| `move` | `["move", id, parent, before\|null]` | Reparent or reorder a subtree. `before` must be a child of `parent` (or `null` for last), and not the node itself. A node can't move into its own subtree. |
| `del` | `["del", id]` | Remove a subtree. Focus inside it goes with it. |
| `settle` | `["settle", id]` | A hint that the subtree is unlikely to change soon. Tern may flatten it and free its view state. Any later op on it, at any depth, brings it back. `settle` restricts no op, but under its [retention budget](operations.md#retention) Tern drops the oldest settled children of `main` first, with a `gone` event. |
| `focus` | `["focus", id\|null]` | The `editor` or `input` that owns the caret and IME, or none ([Input and Events](input.md#keys)). |
| `reveal` | `["reveal", id, "start"\|"end"\|"nearest"]` | Scroll a node into view (a selected list item, a search hit). A `list` the node sits in scrolls to it. A node in `main` scrolls the pane (a screen surface's own `main`); one in `dock` or `layer` scrolls only the containers it sits in. `start` honors the scroller's `scroll-padding`; any other position reads as `nearest`. Only the latest `reveal` applies. |
| `scroll` | `["scroll", id, "line-up"\|"line-down"\|"page-up"\|"page-down"\|"start"\|"end"]` | Keyboard scrolling you forward (PgUp, PgDn and End reach the program): moves the nearest scroll container at or above the node (an `ansi` block with `max.h`, a `list`, a picker pane, a screen surface's `main`) by a line, a viewport less a line, or to an end. Scrolling a following `ansi` away from its tail stops the follow; `end` resumes it. An inline surface's `main` scrolls with the pane and ignores it. Feature `scroll`. |
| `suspend`, `resume` | `["suspend"]`, `["resume"]` | Hand the pane back to the grid and take it again ([Surfaces](surfaces.md#open-and-close)). |

Ops address nodes by id alone, so changing a node deep in the scrollback costs
the same as changing one on screen: `["set","t9",{"collapsed":false}]`
unfolds a card wherever it is.

Tern applies a frame op by op. An op that names an unknown id, adds a kind
outside the vocabulary, breaks a limit or has a malformed argument is rejected
alone, with an event naming its 0-based index; the rest of the frame
applies, so later ops see the document without it:

```text
← ESC _ tsp;e;{"ev":"error","sf":"s1","s":2,"op":1,"msg":"unknown id t7"} ESC \
```

A frame Tern can't take at all (no `sf`, an unknown or closed surface, `ops`
not an array, a body that isn't JSON) is dropped whole with an `error` that
has no `op`.

### Example

Two frames to a flow surface. The first adds `main` with a line of Markdown,
a folded card and a shimmer:

```text
→ ESC _ tsp;f;{"sf":"s1","s":1,"ops":[["add","main","s1",null,{"id":"main","k":"col","c":[
    {"id":"m1","k":"md","p":{"text":"Checking the build"}},
    {"id":"t9","k":"card","p":{"head":"cargo check","status":"running","collapsible":true,"collapsed":true},"c":[
      {"id":"o9","k":"code","p":{"lang":"text","text":"Checking stencil-term v0.1.0\n    Finished dev profile in 4.2s"}}]},
    {"id":"w1","k":"shimmer","p":{"text":"Working"}}]}]]} ESC \
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/protocol-documents-before.light.png" srcset="../figures/protocol-documents-before.light.png 2x" alt="A line reading Checking the build, a folded card cargo check with a Running chip, and a Working label">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/protocol-documents-before.dark.png" srcset="../figures/protocol-documents-before.dark.png 2x" alt="A line reading Checking the build, a folded card cargo check with a Running chip, and a Working label">
<figcaption>After frame 1.</figcaption>
</figure>

The second appends to the Markdown, marks the card done and unfolds it,
removes the shimmer and adds a closing line:

```text
→ ESC _ tsp;f;{"sf":"s1","s":2,"ops":[
    ["text","m1","append",", then the tests."],
    ["set","t9",{"status":"done","collapsed":false}],
    ["del","w1"],
    ["add","m2","main",null,{"id":"m2","k":"md","p":{"text":"All **42** tests pass."}}]]} ESC \
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/protocol-documents-after.light.png" srcset="../figures/protocol-documents-after.light.png 2x" alt="The line now reads Checking the build, then the tests; the card shows Done and its output; the Working label is gone and All 42 tests pass follows">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/protocol-documents-after.dark.png" srcset="../figures/protocol-documents-after.dark.png 2x" alt="The line now reads Checking the build, then the tests; the card shows Done and its output; the Working label is gone and All 42 tests pass follows">
<figcaption>After frame 2: one draw, no intermediate state.</figcaption>
</figure>

## What Tern decides

- **Spacing.** The gap between blocks in `main` and between the parts inside
  one is Tern's rhythm. Don't send blank `text` or `spacer` nodes for it.
- **User settings.** Some looks are the user's, not props: how Markdown
  headings look (annotated at body size, or sized by level), how diffs whose
  `mode` is absent or `auto` lay out (inline or split), whether runs of tool
  calls fold under one head, and the chat style of a transcript (Reader,
  Spine or Console). All of them switch live.
- **Fallback.** A kind the terminal doesn't list in its `hello` reply can be
  sent as `rows`: pre-rendered ANSI lines at the announced `cols`
  ([Text and Code](../elements/text.md#rows)). It exists for migrating a
  renderer component by component.

## Time and animation

- You never send per-frame updates. Motion kinds (`spinner`, `shimmer`,
  `elapsed`, `rate`) and span effects (`fx`) are clocked by Tern at the
  display's refresh rate and pause when the pane is hidden.
- **Ages, not times.** Durations travel as ages: `elapsed.age` (and a
  `tool`'s `age`, an `agent`'s `stats.age`, `tool.age` and `retry.age`) is
  the milliseconds already elapsed when you wrote the frame, negative for a
  countdown, and Tern stores `start = receive time − age`. There is no clock
  to sync, a patch of other props leaves the count running, and replaying a
  snapshot stays right because Tern rewrites ages when it takes the snapshot.
- **Reduce Motion** (the system's setting or Tern's) turns motion into still
  equivalents: a still spinner with its label, no shimmer, timers that still
  tick. The `hello` reply's `reduceMotion` and `motion` events tell you, so you
  can drop motion-only nodes. Per-kind details are in
  [Progress and Motion](../elements/motion.md).
