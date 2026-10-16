# Flow Control, Persistence and Security

## Flow control

- **Credits.** Keep at most `credits` frames (2 unless the `hello` reply says
  otherwise) unacknowledged. An `ack` carries the highest frame `s` the
  window has drawn, and covers every frame up to it: Tern acks once per drawn
  frame, so a frame it applied and drew in one go with the next is never
  acked on its own. While you wait for an `ack`, keep reconciling into a
  pending list of ops, collapsing `set`s on the same id and merging `text`
  appends, and send one frame when the `ack` arrives. A fast window sees
  every frame; a slow one, a busy daemon or ssh latency sees fewer, larger
  frames, and the pty never floods. Credits replace render timers and update
  coalescing.
- **Who acks.** The window that draws the surface sends the `ack`. While no
  window shows the pane (a detached session), none arrive: hold your pending
  ops, and the window that attaches draws the current document and acks it.
  A surface opened with `listen:false` gets no acks, so it sends without
  credits.
- **Streaming.** Stream text as `text append` ops on an `md`, `ansi` or other
  text node: the bytes on the wire are only the new ones, and an `md` node
  re-renders from its last open block on.
- **Settling.** Keep a node's *id* as long as you may want to change the
  node, but not its full description. After `settle`, stop diffing that
  subtree and drop its cached description; send a later change as targeted
  ops by id (`set`, `text replace`, or `del` and `add` of a rebuilt subtree).
  Your memory is then proportional to the live part of the document, not to
  its history. A later op on a settled subtree clears the hint on the node
  it touches and every ancestor, so `settle` the top-level block again when
  you are done with it, or [retention](#retention) can't evict it.
- **Ages.** Durations travel as ages, so there is no clock to keep in step
  ([Time and animation](documents.md#time-and-animation)).

## Retention

A surface's anchor is one grid row, so the scrollback's length alone can't
bound it. Tern gives each pane a surface budget: 64 MiB of document state by
default, an estimate of each node's id and props plus a fixed per-node
overhead, summed over every surface and command block of the pane. Each
frame, palette, stylesheet or close that leaves the pane over budget evicts,
in this order:

1. Closed surfaces and finished command blocks, whole, oldest first.
2. The oldest settled top-level children of `main` of open surfaces. Only a
   child you settled itself counts, not one with a settled descendant. Tern
   reports each with a `gone` event (`{"ev":"gone","sf":…,"ids":[…]}`) when
   the surface listens, and a later op on an evicted id is rejected as an
   unknown node.

When nothing settled is left, the pane stays over budget. Closed surfaces also
go whole when their anchor row leaves the scrollback.

Applying a frame costs Tern time in proportion to its ops, layout is
incremental per changed subtree, and long `main`, `list`, `code`, `ansi` and
`md` content is virtualized: an op on a block 10 000 blocks up the scrollback
applies without laying out anything between it and the viewport.

## Persistence

- The pane's screen owns the surface documents. In a Tern session, the
  session daemon's screen holds them and every attached window receives the
  same bytes, so documents survive a window restart the way grid content
  does.
- A window attaching to a running pane gets a snapshot that replays, through
  the normal parser, a `hello` with your program's `app` and `features`, then
  each surface (closed ones first) as a synthetic `o` (with its mode,
  `listen`, `title` and `role`), its palette (`t`) and stylesheets (`s`), and
  one frame with your last `s` adding the whole document followed by
  `settle`s for settled nodes, the focus and `suspend` when suspended. Closed
  surfaces get their `x` (`keep:true`) after it. Every age Tern clocks
  (`elapsed`, `tool` and `agent` timers, countdowns included) is rewritten
  to the snapshot time. None of Tern's answers to the replay reach your
  program.
- On detach and re-attach, a live surface carries on: your program keeps
  writing into the pty (within its credits) and the new window draws the
  current document.
- A pane restored after its daemon stopped (a crash or a restart) starts a
  new shell. Its inline and flow surfaces and command blocks come back closed
  in the scrollback, read-only, where their anchor rows were; `screen`
  surfaces don't come back.
- Blobs are kept on disk by their SHA-256 (Tern's cache folder, `blobs/`), so
  a snapshot or a restored pane shows its images without your program
  resending them.
- View-only state (folds, control flips, scroll positions) is the window's and
  isn't in a snapshot. Mirror what matters into your props.

## Debugging

- **Recording.** Log every TSP message you write and read, with a timestamp,
  as JSONL lines `{"t":ms,"dir":"out"|"in","verb":"f","params":{…},"body":{…}}`
  (omp writes this with `PI_TUI_TSP_RECORD=<file>`).
- **Replaying.** Tern's scenario command
  `surface-play "<file.jsonl>" [from <frame>] [until <frame>] [paced [<times>]]`
  feeds a recording's `out` messages (`o`, `t`, `s`, `f`, `x`, `b`) into the
  focused pane. A `<frame>` is a frame `s`, or `<sf>#<s>` for one surface's;
  `until` stops after it and `from` starts after it, so a second play can
  continue the first. Without `paced` the whole range lands in one frame;
  `paced` plays it at its recorded pace, `<times>` faster (default 1). A
  hand-written `{"dir":"out","verb":"osc","body":"2;Title"}` line plays as a
  plain OSC and a `pty` line's body is printed as it is, so a recording can
  include the output around its surfaces. The first play restarts the pane as
  a stand-in program that reads and ignores Tern's answers. See
  [Debugging](../guides/debugging.md) for running scenarios and the control
  socket.
- **Inspecting.** The control socket's `tree` command lists a surface's
  elements, found by the `o` `role` its regions carry as `data-surface`
  (`tree "[data-surface='omp.session']"`), and `css` lists the installed
  sheets, yours included as `tsp:<scope>:<name>`, where `<scope>` is the
  view's `data-scope` token (`sf1`, `sf2`, …).

## Security and limits

- No scripts and no raw HTML. `el` builds elements from a fixed tag list with
  an attribute allowlist ([HTML Elements](../elements/el.md)); raw HTML in
  Markdown is drawn as literal text.
- Program CSS only reaches inside its own surface, and it can't load anything
  (`url()`), escape the pane (`position: fixed`) or bring fonts: Tern drops
  `url()` and `position: fixed` declarations and reports them with an
  `error` event, and ignores `@font-face` rules
  ([Stylesheets](theme.md#stylesheets)). Spans and props take tokens, never
  raw colors.
- Links behave like OSC 8 hyperlinks: shown on hover, opened only on an
  explicit gesture. `file://` links are limited to paths; nothing runs a
  command.
- Events carry only ids the program created, plus values the user chose.
  Typed text reaches you as pty input, never as events, with two opt-in
  exceptions: native editing's `edit` events (the `edit` feature) and a
  `send` the user or Carly asked for (the `send` feature)
  ([Input and Events](input.md#native-editing)).

| Limit | Value |
| --- | --- |
| One blob | 16 MiB decoded (larger ones are rejected with `error`) |
| Blobs kept per screen | 256 MiB; past it, unreferenced blobs go, least recently used first |
| Blobs kept on disk | 1 GiB; the least recently shown go when the daemon starts |
| Nodes per surface | 200 000, root included (an `add` reaching it is rejected with `error`) |
| Depth | 64 levels |
| Stylesheets per surface | 256 KiB of CSS, all sheets together (a sheet past it is rejected whole) |
| One APC string | 262 144 bytes; Tern abandons a longer one silently. Chunk bodies at the `hello`'s `apc` (65 536) |
| One chunked message | 24 MiB joined; a sequence idle for 1 s or interrupted by another TSP message is dropped with `error` |
| Surface state per pane | 64 MiB by default ([Retention](#retention)) |
