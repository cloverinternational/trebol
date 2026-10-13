# File Blocks

`file` opens files and drives their text, image and hex views. Use it to
capture loading, editing, disk conflicts and git changes without navigating
through the file picker. Commands target the focused file block, or the most
recently focused file block in the current tab; commands needing a block fail
with `no file block` when there is none.

## Opening files

| Command | Does |
| --- | --- |
| `file open <path> [split\|beside\|tab\|preview] [<line>[:<col>]] [nowait]` | Opens a path, optionally at a text position. |
| `file scratch <name> [split\|beside\|tab\|preview] [nowait]` | Copies a committed fixture into a fresh temporary directory and opens the copy. |
| `file fixture large\|longline\|mdlong\|huge\|bin4g\|git\|gitmd\|editorconfig\|readonly [split\|beside\|tab\|preview] [nowait]` | Generates a temporary fixture and opens it. |

Without placement, opening follows Tern's normal placement policy. `split`
and `beside` are synonyms; `tab` opens in a tab and `preview` requests a
preview block. Placement, position and `nowait` may be reordered after the
path. If several placements are given, the last wins.

Opening normally waits for the current tab's file blocks to load, highlight
and finish updating their git changes, then settles for 350 ms. `nowait`
skips that wait. An unsuccessful open fails the command. Lines and columns
are 1-based; an omitted column means the start of the line.

A relative path first names an existing fixture under
`crates/tern/goldens/fixtures/files`, otherwise it uses the usual fixture/path
resolution described in [Scripts](index.md#fixtures). Absolute paths are
used directly. `scratch` takes a filename, not a path containing `/`; use it
before editing, saving, overwriting or deleting a committed fixture.

Committed fixture names live in that directory: `anim.gif`, `blob.bin`,
`crlf.txt`, `icon.svg`, `latin1.txt`, `links.txt`, `mixed-eol.txt`, `notes.md`,
`photo.jpg`, `report.pdf`, `sample.rs` and `wide.png`.

Generated fixtures:

| Name | Contents |
| --- | --- |
| `large` | One million lines of Rust-like code, about 42 MB. |
| `longline` | One 5 MB line of minified JavaScript. |
| `mdlong` | A long Markdown document with prose, lists, code and tables. |
| `huge` | A 600 MiB log, read-only beyond the editable size limit. |
| `bin4g` | A sparse 4 GiB binary, paged as hex, with marked records every 256 MiB and at the end. |
| `git` | `sample.rs` in a repository with added, changed and deleted lines. |
| `gitmd` | `notes.md` in a repository with changed prose and a table row, a deleted list item and an added task. |
| `editorconfig` | A file under an `.editorconfig` requesting two-space indentation. |
| `readonly` | A file without write permission. |

Large generated fixtures are cached in the system temporary directory.
Fixture creation or copying errors fail the command. Opening is reflected
in `state.file_blocks[]`: `path`, `host`, `kind`, `mode`, `preview` and `load`.
`load` is `opening`, progress `{done,total}`, `ready` or `failed`.

## Views, positions and search

| Command | Does |
| --- | --- |
| `file mode rendered\|source\|hex\|image\|text` | Changes the file's display mode. |
| `file goto <line>[:<col>]` | Moves to a 1-based text position; the column defaults to 1. |
| `file offset <byte>` | Moves the hex view to a decimal or `0x` hexadecimal byte offset. |
| `file select <a> <b> [<a> <b> …]` | Sets text selections by decimal byte offsets; the last pair is primary. Equal endpoints make a caret. |
| `file zoom fit\|100\|actual\|<pct>[%] [<x> <y>]` | Sets image zoom, optionally anchored at a viewport point. |
| `file find "<query>" [regex] [case]` | Opens search in the text or hex view. |
| `file peek <line>:<col>` | Peeks the link or path at a 1-based text position, as a force click would. |

`select` requires at least one complete pair and clamps offsets to the
text length. `offset` needs a hex view; `select` and text search need a code
view; `zoom` needs an image view. Unsupported views fail those commands.
Numeric zoom percentages must be positive; both anchor coordinates are
required if either is supplied. Search defaults to literal, case-insensitive
matching. `regex` and `case` may appear in either order; hex search uses
`case` but ignores `regex`. Use `file wait` to wait for hex search counting.

`peek` fails if there is no link or path there, or nothing can be peeked.
It waits in real time for the peek's text to load and highlight. Other
commands in this group settle for 350 ms.

State reports `mode`, text `caret` and `selections`, image `zoom`, and hex
`hex.selection`, `hex.matches`, `hex.counted` and `hex.current`. There is no
file-block state field for a peek or the text search query.

## Saving and disk changes

| Command | Does |
| --- | --- |
| `file save` | Requests a save of the target block. |
| `file disk "<text>"` | Overwrites the target file on disk, allowing its watcher to reload it or show a conflict. |
| `file delete-on-disk` | Deletes the target file on disk. |
| `file autosave off\|focus\|<ms>` | Disables auto-save, saves on focus change, or sets its delay in milliseconds. |

`save` settles for 350 ms, not necessarily until saving finishes; follow it
with `file wait saved` when the result matters. `disk` and `delete-on-disk`
fail on filesystem errors and wait 1.5 seconds of real time for the watcher.
That is a fixed delay, not a check that a reload or conflict has arrived.
Auto-save changes the saved file preferences, not just the target block,
and does not require an open file block.

Check `state.file_blocks[].dirty` and `bar` for unsaved changes and conflict,
deleted-file or other notices. There is no auto-save setting in those rows.

## Menus and git changes

| Command | Does |
| --- | --- |
| `file menu more` | Opens the file block's more menu. |
| `file choose <action>` | Runs a file menu action without opening the menu first. |
| `file change <n> hover\|toggle\|revert\|stage` | Shows a git change's hover controls, toggles its old lines inline, reverts it as one undoable edit, or stages it. |

Action names are `compare`, `keep-mine`, `use-disk`, `recreate`, `close`,
`discard`, `reveal`, `open-outside`, `retry`, `save-as`, `view-hex`,
`view-text`, `save`, `revert`, `wrap`, `copy-path`, `copy-relative-path`,
`create-folders` and `copy-markdown`. These argument forms are also accepted:

| Command | Does |
| --- | --- |
| `file choose mode:rendered\|mode:source\|mode:hex\|mode:image\|mode:text` | Selects a display mode. |
| `file choose eol:lf\|eol:crlf\|eol:cr` | Converts the document's line endings. |
| `file choose reopen:<encoding>` | Reopens using an encoding label. |

Encoding labels are `utf-8`, `utf-16le`, `utf-16be`, `windows-1252`,
`iso-8859-1`, `iso-8859-15`, `macintosh`, `windows-1250`, `windows-1251`,
`koi8-r`, `windows-1253`, `windows-1254`, `windows-1255`, `windows-1256`,
`shift_jis`, `euc-jp`, `euc-kr`, `gbk`, `gb18030` and `big5`.

Menu actions depend on the file's state and view. An unknown action name
fails the script, listing the valid ones. `menu more` fails
without a file view. Native dialogs or external applications requested by
an action depend on the platform; the `file` family itself has no
desktop-only or headless-only restriction.

Git change indices are 0-based. Changes need a code view and a valid change
index; staging also fails when the change cannot be staged. Reverting and
staging wait for loading, highlighting and current git changes; hover and
toggle settle for 350 ms. State exposes resulting `dirty`, `bar` and `mode`,
but not menu visibility, wrap settings or git hunk details.

## Waiting

| Command | Does |
| --- | --- |
| `file wait` | Waits for every file block in the current tab to load, highlight, finish hex search counting and update git changes. |
| `file wait loaded` | Waits for every file block in the current tab to load or fail, then runs one frame without waiting for highlighting. |
| `file wait saved` | Waits until no save is running and no auto-save delay is pending. |

`wait` and `wait loaded` fail when the current tab has no file block.
`wait saved` does not require one. These waits use real time and the
script's 20-second timeout; `wait` and `wait saved` also settle for 350 ms.
A failed load counts as finished, so inspect `state.file_blocks[].load`
rather than treating a completed wait as proof that a file loaded correctly.
A screenshot after `wait loaded` may still wait for viewport highlighting.

## Examples

Edit a scratch copy and capture an external-write conflict, as in the
file-conflict scenario:

```text
ready
file scratch sample.rs split
file select 0 0
type "// mine\n"
file disk "// theirs\n"
shot file-conflict
```

Capture a regex search, as in the file-code-find scenario:

```text
ready
file open sample.rs split
file find "Task::\\w+" regex
shot file-code-find
```

## See also

- [Scripts](index.md): running commands, timing and fixture roots.
- [Files Pane](files.md): navigating directories before opening a file.
- [Git Blocks](git.md): working with repository changes.
- [Harness Commands](harness.md): typing, keys, dialogs and screenshots.
- [Debugging](../guides/debugging.md): driving a window from a script.
