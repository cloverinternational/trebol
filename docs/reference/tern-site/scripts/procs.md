# Task Manager

`procs` opens and drives task-manager blocks: live processes, machine meters,
flat or tree arrangements, filtering and process selection. Use it to capture
process views or open a selected process's menu and quit confirmation.

## Opening a block

| Command | Does |
| --- | --- |
| `procs open` | Opens a task-manager block beside the focused pane and focuses it. Waits for its first displayed sample. |

A new block starts as a flat list sorted by CPU, busiest first. It lists the
processes of its pane's host, not necessarily the window's machine. Samples
are live, including in headless runs; there is no process fixture.

`open` waits for real sampling, with the script's 20-second timeout, then
settles for 450 ms. Local sampling depends on platform support; remote
sampling needs a connected host that supports process lists. An unavailable
sample can leave `open` waiting until it times out. These commands are not
headless-only; their script implementation is native, not the web client.

`tern ctl state` records blocks in `task_manager_blocks.blocks[]`, with `id`
and `sampled`. The containing object also reports `paused`, `interval_ms`
and the local sample's `seq`. Samplers run while a block for their machine
is visible in the current tab and updates are not paused.

## Arranging and filtering

| Command | Does |
| --- | --- |
| `procs sort name\|pid\|user\|cpu\|memory\|gpu\|threads\|disk` | Sorts the focused task-manager block by that column; repeating its current column reverses the order. |
| `procs tree on\|off` | Nests children under parents, or returns to a flat list. |
| `procs filter ["<text>"]` | Sets the filter; omitted or empty text clears it. |

Choosing a different column starts name, PID and user in ascending order;
CPU, memory, GPU, threads and disk start descending. In a tree, sorting
orders siblings. Filtering matches name, user or command line without case
sensitivity; an all-digit filter also matches the start of a PID.

All commands except `open` require a focused task-manager block, otherwise
fail with `no task-manager block has focus`. Missing or unknown sort columns
and tree values are parse errors. Each command settles for 450 ms, rather
than waiting for a fresh sample.

State fields for each block are `sort`, `descending`, `tree`, `filter` and
`rows` (the arranged row count). Sorting and tree mode are shared session
state; filtering and selection belong to this window.

## Selecting and acting

| Command | Does |
| --- | --- |
| `procs select ["<name>"]` | Selects only the first displayed row whose process name matches exactly, and scrolls it into view. |
| `procs menu` | Opens the process row menu for the selection. |
| `procs quit [force]` | Asks to quit the selected processes; `force` asks to force quit instead. |

Selection searches the current arranged rows, so filtering or folded tree
branches can hide a target. It fails with `no sample yet` without a sample,
or `no row is called …` without an exact name match. Omitting the name is
accepted as an empty name, not as a request to clear selection.

`quit` opens a confirmation, not an immediate signal, and does nothing when
no processes are selected. Confirmed Quit sends a termination request;
Force Quit kills the targets. On Windows, Quit uses process termination.
For a remote block, signals go to that host. Use the harness's `dialog`
command to answer the confirmation. These commands settle for 450 ms; they
do not wait for a process to exit.

The block's `selected` state field contains selected PIDs. Menus and pending
confirmations are inspected through the control endpoint's `menus` and
`system` commands, not additional task-manager fields.

The parser ignores trailing words after `open`, `sort`, `tree` and `menu`.
For `quit`, only the word immediately after it equal to `force` enables
force quit; another word still parses as ordinary Quit. `filter` and
`select` consume all remaining words as their text, so quote names and
filters containing spaces.

## Examples

A full-tab process tree sorted by memory, as in the `procs-tree` golden:

```text
ready
procs open
zoom
procs tree on
procs sort memory
wait 2500
shot procs-tree
```

Select Tern's process and show its details, as in the `procs` golden. This
requires a displayed process named exactly `tern`:

```text
ready
procs open
wait 2500
procs select "tern"
wait 450
shot procs
```

The extra waits allow live samples to accumulate; they do not make process
names, PIDs or usage deterministic.

## See also

- [Scripts](index.md): running scripts, syntax and timing.
- [Harness Commands](harness.md): screenshots and confirmation dialogs.
- [Control Commands](control.md): state, menus and system inspection.
- [Profile Blocks](profile.md): recording a selected process.
- [Remote Hosts](remote.md): attaching the host whose processes are listed.
- [Debugging](../guides/debugging.md): driving a window from a script.
