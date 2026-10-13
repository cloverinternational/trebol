# Files Pane

`files` drives the directory tree beside Tern's blocks: its root, expanded
folders, selection, filter and live updates. Use it to navigate a real
folder or put the pane into a repeatable state for screenshots, loading
states and large-tree measurements.

## Pane and root

| Command | Does |
| --- | --- |
| `files show` | Opens the Files pane. |
| `files hide` | Closes the Files pane. |
| `files toggle` | Switches the pane between open and closed. |
| `files focus` | Gives the Files pane keyboard focus. |
| `files root <path>` | Opens the pane and pins the current tab's root to a local path. |
| `files follow` | Removes the current tab's pin so the root follows the focused block again. |
| `files width <px>` | Sets the pane width in pixels. |

Quote paths containing spaces. `root` does not require a readable directory:
an unreadable or missing root is shown as a pane error, rather than failing
the command. Width accepts a whole number from 0 to 65535; missing or invalid
values fail parsing. Pinning is per tab.

Except for row lists and filter text, commands consume only the arguments
shown; trailing words are ignored. Missing required paths fail parsing.

`tern ctl state` reports these changes under `files`: `shown`, `focused`,
`width`, `root`, `host`, `pinned` and `error`. With no root, this entry has
only `shown` and `root: null`.

## Rows and filtering

| Command | Does |
| --- | --- |
| `files expand [<rel> …]` | Opens the named folders, including ancestors whose listings have not arrived yet. |
| `files collapse [<rel> …]` | Closes the named folders. |
| `files select [<rel> …]` | Replaces the selection with the first row, then toggles each additional row into or out of it. |
| `files cursor [<rel> …]` | Selects each named row alone in turn; the last becomes the cursor and sole selection. |
| `files reveal <rel>` | Opens the pane, reveals the relative path and focuses the rows. |
| `files filter [<query> …]` | Opens the filter and sets its text; no words or `""` clears it. |

Paths are relative to the shown root. `expand` can request paths not yet
listed and arrange for them to open as listings arrive. Other row commands
fail if a path is not listed; `select` and `cursor` also fail if the row is
not shown, for example inside a collapsed folder. Nonempty row operations
need a root. An empty argument list is accepted and leaves the selection
unchanged. Selection commands focus the rows when they select anything.

Filter words are joined with spaces, so both `files filter "view rows"` and
`files filter view rows` set the same query.

Inspect `files.visible`, `rows` and `loaded` for the tree, and `cursor` and
`selected` for selection. `visible` includes at most 200 rows, with depth
shown as indentation; `selected` includes at most 64 paths. `files.filter`
reports the query, match and indexed counts, completion flag and timings.
`files.pool` reports the visible row range, scroll position and deferred
work when a row pool exists.

## Generated fixtures and performance

These fixtures are built in a temporary directory, not read from the
source-tree fixture folder. Each build gets its own directory. A fixture
opens the pane, changes the focused block's working directory and sends
`cd` to its shell when it has one. It fails if there is no focused block or
if creating the fixture fails. A pinned root still takes precedence; use
`files follow` first if necessary. Use `ready` afterward when the next step
needs the shell prompt.

| Command | Does |
| --- | --- |
| `files fixture small` | Builds mixed file kinds, dotfiles, a compact folder chain and, on Unix, a directory symlink. |
| `files fixture git` | Builds a repository with modified, staged, untracked, conflicted and ignored files, with pinned commit dates. |
| `files fixture wide` | Builds 10000 files inside `wide`, plus a root README. |
| `files fixture deep` | Builds a nested compact chain and folders suitable for a three-level sticky-header stack. |
| `files fixture denied` | Builds the small tree plus `locked/secret.txt`; on Unix, removes permission to access `locked`. |
| `files fixture empty` | Builds an empty directory. |
| `files fixture synth [<n>]` | Builds a balanced tree, using folders of 32 entries and up to three folder levels before files. |
| `files model <n>` | Replaces the root's in-memory listing with synthetic open folders and files, without writing to disk. |

`synth` accepts an optional nonnegative count. Missing or unparseable counts
become 0, and the builder uses at least 1. The other fixture names accept
an optional count too, but do not use it. Unknown fixture names fail.
The Git fixture requires a working `git` executable. The denied fixture's
permission change and the small fixture's symlink are Unix-only; permission
failures depend on the user running Tern.

`model` requires a root and a nonnegative whole-number count. It creates
`min(100, max(1, n))` folders named `dir000`, `dir001`, …, each with
`n / folder-count` files, rounded down. Files use `.md` every seventh entry
and `.rs` otherwise. All folders are expanded and the selection is cleared;
0 produces one empty folder. Disk listings can subsequently replace this
synthetic tree.

Fixture results appear in `files.root`, `repo`, `error`, `visible` and
`loaded`. For large trees, inspect `files.mem`, `firstRowsMs`, `lastListMs`,
`status`, `filter` and `pool` alongside `rows` and `loaded`.

## Disk changes and live updates

| Command | Does |
| --- | --- |
| `files touch <rel>` | Creates parent directories and writes an empty file, truncating an existing file. |
| `files rm <rel>` | Deletes a file or recursively deletes a directory. |
| `files storm <n>` | Creates `storm/f0` through `storm/f<n-1>` under the root. |
| `files hold` | Holds listing answers to keep loading states visible. |
| `files release` | Releases held answers and processes available replies. |
| `files poll` | Switches from watching to polling, showing the “Not live” state. |
| `files watch` | Enables watching again. |
| `files wait` | Waits until no listing, status, filter or operation work is pending. |

**Disk commands change real files under the current root.** Use a generated
fixture when testing them. They require a root and fail on filesystem
errors; `rm` fails for a missing path. `storm` accepts a nonnegative
whole-number count and does not remove files left by an earlier storm.
These commands perform local filesystem operations, even if the pane is
showing a remote root; they are intended for local fixtures.

Commands settle on pending Files work, then advance script time by 350 ms.
`touch` and `rm` use 600 ms instead; `storm` uses 1000 ms. Waiting for real
work has the script's 20-second timeout. A held pane counts as settled even
when work remains, so `files wait` does not release held answers or block
on them. `release` resumes normal settling. The family has no desktop-only
or headless-only restriction.

`files.pending` reflects work in flight; it may remain true while held.
`files.live` reflects watching. `events` and `relists` count watcher events
and relistings, while `lastListMs` records listing time. There is no separate
state field for the hold flag.

## Examples

A Git fixture with nested folders and a selected changed file, as used in
the Files layout scenarios:

```text
ready
files fixture git
ready
files expand src src/view
files select src/view/rows.rs
files wait
shot files-git-selection
```

A filter with matches, then one with none, from the Files filter scenario:

```text
ready
files fixture small
ready
files filter "vfr"
files wait
shot files-filter
files filter "zzqx"
files wait
shot files-filter-none
```

## See also

- [Scripts](index.md): syntax, timing and running a script.
- [File Blocks](file.md): opening and editing files in blocks.
- [Remote Hosts](remote.md): browsing an attached host.
- [Harness Commands](harness.md): keyboard input and screenshots.
- [Debugging](../guides/debugging.md): driving a window from a script.
