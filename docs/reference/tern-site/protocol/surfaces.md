# Surfaces

A **surface** is a document a program shows in its pane. Everything in a live
surface stays editable at any time, including the parts that scrolled up into
history: scrollback is part of the document, not a sealed record of past rows.
A pane holds any number of closed surfaces in its scrollback, but at most one
live surface of each mode per screen buffer.

## Modes

| Mode | For | Sits | After the program |
| --- | --- | --- | --- |
| `inline` (default) | A program that runs a session in the pane (omp) | At the cursor row of the main screen, owning the pane while live | Discarded at the next shell prompt |
| `screen` | A full-screen view (an app, a full-screen overlay) | Over the whole pane, like the alternate screen | Discarded on close |
| `flow` | A program that isn't full-screen: a CLI that prints a table, asks a question or shows progress, then exits (feature `flow`) | At the cursor row of the main screen, among the output around it | Kept in the scrollback, like output |

## Open and close

```json
// tsp;o
{"id":"s1","mode":"inline","title":"omp","role":"omp.session"}
```

| Field | Meaning |
| --- | --- |
| `id` | Your name for the surface: frames and events carry it as `sf`. Required; an `o` without one is an error. Give each open surface its own id: `f` and `x` go to the first open surface with it, the active screen buffer's first. |
| `mode` | `inline`, `screen` or `flow`. An unknown mode is an error. |
| `title` | Names the pane until your program sets its own title (OSC 0/2). |
| `role` | Names the surface for style sheets: it is `data-surface` on the surface's three region elements (`omp.session`, `omp.rewind`). Not `data-role`, which belongs to the region nodes. |
| `adopt` | `true` reopens a closed inline surface (below). |
| `listen` | `false` says the program never reads its input (below). Default `true`. |

- **Inline.** Anchored at the cursor row of the main screen; it flows with
  the scrollback. While live it owns the pane like the alternate screen
  (**clean pane**): the shell's rows, the command that started the program,
  the scrollback and older closed surfaces are not drawn, and nothing scrolls
  above the surface's first row. They come back when the surface closes or
  suspends. Opening one on the alternate screen is an error.
- **Screen.** Fills the pane like the alternate screen, overlays included.
  It is discarded on close, whatever `keep` says.
- **Flow.** Anchored at the cursor row of the main screen like `inline` (an
  error on the alternate screen), but it never owns the pane: the shell's rows
  above it and the output below it stay, and it spans the pane like the rows
  do, without a transcript's chat style. It is command output: closing it
  (`x` with `keep:true`, or the program exiting) keeps it in place, and so does
  the next shell prompt, which closes it first if the program left it open. It
  stays until its anchor row leaves the scrollback. While open it is a live
  surface like an inline one, with frames, events, a `dock` and a `layer`.
- **Not listening.** `listen:false` (any mode) says the program never reads
  its input. Tern then sends nothing about the surface: no acks (send frames
  without waiting for credits), no events, no errors, and no answers at all
  until your next `q` or listening `o`. Its controls don't flip. A program
  that prints a static view this way needs no raw mode and leaves nothing in
  the input queue for the shell:

  ```text
  ESC _ tsp;o;{"id":"ls","mode":"flow","listen":false} ESC \
  ESC _ tsp;s;{"sf":"ls","name":"main","css":".size{text-align:right}"} ESC \
  ESC _ tsp;f;{"sf":"ls","s":1,"ops":[["add","main","ls",null,{"id":"main","k":"col","c":[
    {"id":"t","k":"el","p":{"tag":"table"},"c":[
      {"id":"a","k":"el","p":{"tag":"tr"},"c":[
        {"id":"a.n","k":"el","p":{"tag":"td","text":"Cargo.toml"}},
        {"id":"a.s","k":"el","p":{"tag":"td","class":"size","text":"2.1K"}}]},
      {"id":"b","k":"el","p":{"tag":"tr"},"c":[
        {"id":"b.n","k":"el","p":{"tag":"td","text":"README.md"}},
        {"id":"b.s","k":"el","p":{"tag":"td","class":"size","text":"14K"}}]},
      {"id":"c","k":"el","p":{"tag":"tr"},"c":[
        {"id":"c.n","k":"el","p":{"tag":"td","text":"build.rs"}},
        {"id":"c.s","k":"el","p":{"tag":"td","class":"size","text":"312"}}]}]}]}]]} ESC \
  ESC _ tsp;x;{"id":"ls","keep":true} ESC \
  ```

  <figure class="tn-figure">
  <img class="tn-light" loading="lazy" decoding="async" src="../figures/protocol-surfaces-ls.light.png" srcset="../figures/protocol-surfaces-ls.light.png 2x" alt="A three-row table of file names with their sizes right-aligned, kept in the pane as command output">
  <img class="tn-dark" loading="lazy" decoding="async" src="../figures/protocol-surfaces-ls.dark.png" srcset="../figures/protocol-surfaces-ls.dark.png 2x" alt="A three-row table of file names with their sizes right-aligned, kept in the pane as command output">
  <figcaption>The closed flow surface: the table spans the pane like the rows around it.</figcaption>
  </figure>

- **Screen over inline.** A program that doesn't use the alternate screen
  shows a full-screen view by opening a screen surface while its inline
  surface is live. The screen surface covers the pane: the grid rows and the
  inline surface's `main`, `dock` and overlays are hidden, and pointer input,
  the caret and view events (`resize`, `visible`) go to the screen surface. It
  never closes or changes the inline surface: its document, `dock`, `layer`,
  focus and frame sequence stay as they were, and frames addressed to it still
  apply. When the screen surface closes, the inline surface shows again
  exactly as it was. Nothing has to be resent.
- **Replacement.** A new `o` replaces the buffer's live surface of the same
  mode: an inline or flow one is closed as if `keep:true`, a screen one is
  discarded. A new inline `o` (a program starting its session) also discards
  any screen surface still covering the buffer. A screen `o` never touches
  the inline surface, and neither touches a flow surface.
- **Close.** `x` with `{"id":"s1","keep":true}` closes the surface: its
  live-only regions (`dock`, overlays, focus) go and its `main` stays in the
  scrollback, until the shell's next prompt for an inline surface and for good
  for a flow one. `keep:false` removes it. `keep` defaults to `true`.
- **Adopt.** `o` with `{"id":"s1","adopt":true}` reopens the newest closed
  inline surface with that id still in this pane's scrollback: the same
  document, fully editable again, with no `dock` or `layer` (close dropped
  them; add them again). `mode` is ignored; `title` and `role` replace the
  old ones when given, and `listen` applies as on any `o`. Like a new inline
  `o`, it closes the buffer's live inline surface (as if `keep:true`) and
  discards a screen surface; adopting the id that is already live does
  nothing. A program adopts after a stop/start cycle (an external editor) so
  its transcript continues in place instead of printing a second copy. If
  the id isn't in the pane, Tern answers `{"ev":"gone","ids":["s1"]}` (unless
  the `o` says `listen:false`) and you open a new surface.
- **Suspend.** The `["suspend"]` and `["resume"]` frame ops hand the pane back
  to the grid for a while (an interactive shell command, an external
  `$EDITOR`). A suspended surface keeps its place and takes no pointer focus;
  grid output appears below it.
- **Crash safety.** When the pane's process exits, every live surface closes:
  inline and flow ones as if `keep:true` (a dead pane stays to be read),
  screen ones discarded. RIS (`ESC c`) clears the screen and its surfaces with
  it. The program is then known to be gone, and Tern sends nothing more until
  something asks (`q`) or opens a surface (`o`).
- **Back at the prompt.** A shell prompt (OSC 133;A) means the program is
  gone. Tern discards every inline and screen surface of the pane, including
  the ones closed with `keep:true`, so quitting a session program takes its
  transcript off the pane and the shell's rows show as they were. If the
  program wrote nothing to the grid below its inline surface's anchor, the
  anchor row is undone and the shell's cursor is back where the program
  found it. Flow surfaces and Tern's own command-lens blocks stay: they are
  command output.
  `keep:true` on an inline surface therefore lasts only while the program
  owns the pane without a prompt in between. After a job-control suspend
  (`^Z`, `fg`) an `adopt` hears `gone`.
- **Leaving.** Close your surfaces (`x`) *before* you stop reading input, then
  drain the input briefly, so replies and events in flight never reach the
  next reader of the pty. That reader is usually the shell, which takes them
  as typed text: zsh reads `ESC _` as insert-last-word. Never print or echo
  TSP input. A program that doesn't read input opens with `listen:false`
  instead.
- **Title.** When a command opens its first listening surface (not
  `listen:false`), Tern drops the title the shell gave the pane (zsh's
  preexec title is the command line), so the `o` `title` names the pane
  until the program sets its own; set yours after the `o`. Later surfaces of
  the same command leave the program's title alone.
- **Stray output.** Bytes that aren't TSP while a surface is live (a
  library's logging, stderr) go to the grid as usual. While an inline surface
  owns the pane they stay hidden with the rest of the grid until it closes or
  suspends.
- **Alternate screen.** A program that switches to the alternate screen (a
  `vim` your program starts) covers the pane as usual. Inline and flow
  surfaces belong to the main screen and come back when it ends. A screen
  surface belongs to the buffer that was active when it opened: one opened
  on the alternate screen goes when the program leaves (or clears) the
  alternate screen, and a listening program hears
  `{"ev":"gone","sf":"s1","ids":["s1"]}`.

## Anchoring in the grid

An inline or flow surface occupies exactly one grid row, its **anchor**. On
`o`, Tern ends the cursor's row first if it holds anything (the cursor past
column 0, text, another anchor), turns the cursor's row into the anchor and
moves the cursor to the start of the row below. The anchor is the
only row the surface takes in the grid's arithmetic, so nodes deep in the
scrollback can grow, shrink, appear or vanish without moving, inserting or
rewrapping a single grid row. The anchor never joins a wrapped line on
resize, isn't trimmed as blank and scrolls into history like any row.
Snapshots carry it with its document.

The surface lives exactly as long as its anchor row. When the row falls off
the end of the scrollback, is erased (`ESC [2J`, `clear`) or scrolled away
inside a scroll region, or the scrollback is cleared, the surface goes with
it, and an open one whose program listens hears
`{"ev":"gone","sf":"s1","ids":["s1"]}`.

Tern draws the pane as runs of grid rows at a fixed height separated by
surface blocks at their natural height. Selection, mouse reporting, links,
find and the cursor all go through that layout.

**Scroll anchoring.** When content changes height above what the user is
looking at (a folded card expands in the scrollback, a past entry is
replaced), the view stays on the content under the viewport; nothing jumps.
Inside a surface the scroll position is a child of `main` and how far into it,
so children above it changing height carry it along. While the view follows
the live end, the tail stays pinned instead. Ops on nodes out of view apply
to the document at once; their layout waits until they come into view, with
an estimate in the meantime.

## Regions

A surface's root (its id is the surface's `id`) has up to three children
with fixed ids:

| Id | Holds |
| --- | --- |
| `main` | The flowing document (a transcript). It scrolls with the pane. |
| `dock` | Sticky at the pane's bottom while the surface is live: an editor, a status line, a working indicator. Removed on close. The pane lays `main` out above it and keeps the tail in view until the user scrolls up. |
| `layer` | Overlays floating above everything ([Overlays](../elements/chrome.md#overlay)). Removed on close. |

```text
ESC _ tsp;f;{"sf":"s1","s":1,"ops":[
  ["add","main","s1",null,{"id":"main","k":"col","c":[
    {"id":"m1","k":"text","p":{"text":"Checked 214 crates."}},
    {"id":"m2","k":"text","p":{"text":"Cargo.lock pins serde 1.0.219."}},
    {"id":"m3","k":"text","p":{"text":"serde 1.0.228 is out."}},
    {"id":"m4","k":"text","p":{"text":"Run cargo update -p serde?"}}]}],
  ["add","dock","s1",null,{"id":"dock","k":"col","c":[
    {"id":"ed","k":"editor","p":{"placeholder":"Ask anything"}},
    {"id":"bar","k":"status","c":[
      {"id":"br","k":"seg","p":{"icon":"branch","text":"main"}},
      {"id":"st","k":"seg","p":{"side":"right","text":"ready"}}]}]}],
  ["add","layer","s1",null,{"id":"layer","k":"col","c":[
    {"id":"ask","k":"overlay","p":{"anchor":"top","size":"sm","head":[{"t":"Update serde"}]},"c":[
      {"id":"ask.t","k":"text","p":{"text":"1.0.219 → 1.0.228"}}]}]}],
  ["focus","ed"]]} ESC \
```

<figure class="tn-figure">
<img class="tn-light" loading="lazy" decoding="async" src="../figures/protocol-surfaces-regions.light.png" srcset="../figures/protocol-surfaces-regions.light.png 2x" alt="An inline surface: four transcript lines in main, an editor and a status strip docked at the bottom, and an overlay card floating over the transcript">
<img class="tn-dark" loading="lazy" decoding="async" src="../figures/protocol-surfaces-regions.dark.png" srcset="../figures/protocol-surfaces-regions.dark.png 2x" alt="An inline surface: four transcript lines in main, an editor and a status strip docked at the bottom, and an overlay card floating over the transcript">
<figcaption>One inline surface: <code>main</code> above, <code>dock</code> at the bottom, the <code>layer</code>'s overlay over both.</figcaption>
</figure>

Each region draws into an element of its own, not a node of its kind: the
region node's kind and its props other than `role` are ignored (a `col`
draws no `.sf-col`, its `gap` or `class` does nothing), and its children
go straight into the region element. Style the regions through these:

```html
<div class="sf-region sf-main" data-scope="sf1" data-surface="omp.session" data-role="…">…</div>
<div class="sf-region sf-dock" data-scope="sf1" data-surface="omp.session">…</div>
<div class="sf-region sf-layer" data-scope="sf1" data-surface="omp.session">…</div>
```

| Target | Selector |
| --- | --- |
| Any region | `.sf-region` |
| One region | `.sf-main`, `.sf-dock`, `.sf-layer` |
| By the `o` `role` | `[data-surface='omp.session']` (all three regions) |
| By the program's `hello` `app` | `[data-app='hermes']` (all three regions) |
| By the region node's `role` prop | `.sf-main[data-role='…']` |
| Under a modal or full overlay, or a `picker` | `.sf-main.sf-covered`, `.sf-dock.sf-covered` |

A screen surface's regions share its cover: `main` takes the height and
scrolls itself (a `reveal` scrolls it, not the pane), and `dock` sits under
`main`.

**Aside** (feature `aside`). A `prefs` node in an inline surface's `layer` is
a sheet docked at the pane's right edge, not an overlay: the pane reserves the
width of Tern's own settings sheet for it (at most 60% of the pane), the grid
rows, `main` and `dock` end beside it, and you get the narrower `cols` in a
`resize`. The rest of the surface stays live beside the sheet; keys go wherever
your `focus` says, and a click moves them with a `focus` event. Closing the
node or the surface gives the width back.
