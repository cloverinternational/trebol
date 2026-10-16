# Profile Blocks

`profile` opens sampled call stacks as a flame graph, records a process
selected in a task-manager block, and drives the graph and its functions
sheet. Use recorded fixtures for repeatable screenshots, or record a live
process to inspect where it spends its time.

## Open and record

| Command | Does |
| --- | --- |
| `profile fixture <name>` | Opens the committed profile named `<name>` in a new block beside the focused pane. |
| `profile open <path>` | Opens a sample report or folded stacks file in a new profile block. |
| `profile record` | Opens a new block recording the focused task-manager block's selected process. |
| `profile stop` | Ends the focused profile block's recording early and keeps the samples. |

Fixtures live in `crates/tern/goldens/fixtures/profile`. The name omits the
extension: Tern tries `<name>.sample.txt`, then `<name>.folded`. An unknown
fixture fails the command. See the [fixture setup](index.md#fixtures) for
shipped builds. Quote paths or names containing spaces.

`record` requires a focused task-manager block with one process selected;
otherwise it fails. Recording lasts up to 20 seconds of real time. It
settles for 1,500 ms after starting, rather than waiting for the whole
recording. Sampling uses the platform's recorder: `sample` on macOS,
`perf` on Linux, and a native sampler on Windows. Permissions and available
sampling tools can prevent recording. If Tern has no cache folder to keep
the recording, it shows a toast instead of opening a block.

`fixture`, `open` and `stop` wait for the focused block to show either its
graph or its error, then settle for 400 ms. The real-work wait times out
and fails after 20 seconds. A file or recording error displayed in the
block completes the wait; it is not itself a command failure. `stop`
requires a focused profile block, but need not be called if recording has
already ended.

These commands work in headless runs and native windows. The web client
cannot read local profiles or sample processes.

## Navigate and highlight

| Command | Does |
| --- | --- |
| `profile zoom <function>\|root` | Zooms into the function's heaviest box; `root` shows the whole profile. |
| `profile select <function>` | Reveals and selects the function's heaviest box. |
| `profile hover <function>` | Reveals the function's heaviest box and puts the pointer over it. |
| `profile pick <function>\|none` | Highlights every call of the function; `none` clears the picked function. |
| `profile find [<text>]` | Searches the profile and highlights matching functions; no text or `""` clears the search. |

These commands act on the focused profile block, as do all display commands
below. Without one, they fail. Function lookup requires a loaded graph. It
tries the full function name, then its shortened name, then a name containing
the supplied text. When several match, it chooses the one with the greatest
total sample count. An unmatched function, or a function without a graph
box for `zoom`, `select` or `hover`, fails the command. Quote function names
containing spaces.

Search text is stored lowercase. `pick` highlights all calls, while
`select` and `hover` target one box. `root` and `none` are reserved for their
respective commands. Each command settles for 400 ms.

## Display and functions sheet

| Command | Does |
| --- | --- |
| `profile invert on\|off` | Shows bottom-up stacks (`on`) or top-down stacks (`off`). |
| `profile idle on\|off` | Shows or hides samples caught waiting idle. |
| `profile thread <name>\|all` | Shows one named thread, or all threads. |
| `profile sort self\|total` | Orders the functions sheet by self time or total time. |

New blocks start top-down, with idle samples hidden, all threads shown,
an empty search, and the functions sheet sorted by self time. Thread names
must match exactly; an unknown thread fails. `all` restores all threads.
Switches require `on` or `off`; sorting requires `self` or `total`. These
commands settle for 400 ms.

## State

`tern ctl state` reports profile blocks in `profile_blocks.blocks`. Each
entry has `id`, `process`, `pid` and `show`. The latter can be `blank`,
`sampling`, `reading`, `elsewhere`, `interrupted`, `failed` or `ready`.
Check it after opening or stopping a recording, since a displayed failure
also completes those commands' waits.

Graph commands update `focus` (zoom), `selected`, `picked` and `query`.
`focus` is null at the root. Display commands update `inverted`,
`show_idle`, `thread` (null for all threads) and `sort`. The entry also
reports `samples`, `hidden`, `nodes`, `depth`, `threads`, `span`,
`functions` and `side`.

## Examples

Open the committed Tern profile, zoom into its style flush, and show a
matching function's hover card:

```text
ready
profile fixture tern
zoom
profile zoom "<stencil_ui::tree::Document>::flush"
profile find "stencil_ui::style"
profile hover "stencil_ui::style::visit_children"
wait 300
shot profile-zoom
```

Record the Tern process selected in a task-manager block, then stop early:

```text
ready
procs open
wait 2500
procs select "tern"
profile record
shot profile-record
profile stop
shot profile-recorded
```

## See also

- [Task Manager](procs.md): select the process to record.
- [Terminal and Panes](terminal.md): pane focus and pane zoom.
- [Harness Commands](harness.md): pointer input and screenshots.
- [Scripts](index.md): syntax, timing and fixture setup.
- [Debugging](../guides/debugging.md): driving a running window.
