# Notebook Blocks

`notebook` commands open and edit Jupyter notebooks, run their cells with a
real kernel, and drive search, completion and notebook sheets. Use them to
exercise notebook editing or capture actual execution results. They are
available only on desktop builds, not iOS or the web.

## Opening and selecting

| Command | Does |
| --- | --- |
| `notebook fixture <name>` | Copies `<name>.ipynb` from the notebook fixtures into a temporary folder and opens it beside the focused pane. |
| `notebook new` | Creates a notebook in a fresh temporary folder. |
| `notebook open <path>` | Opens an existing notebook using the normal opening placement. |
| `notebook select <n>` | Selects cell `<n>` alone and enters command mode. |
| `notebook edit` | Enters edit mode on the active cell. |
| `notebook command` | Returns to command mode. |
| `notebook type <text>` | Inserts text at the edited cell's carets; `\n` becomes a newline. |

Cell numbers are zero-based. Selecting an out-of-range cell fails with the
notebook's cell count. Typing fails unless a cell is being edited. Except
for opening commands and `wait`, commands require a focused notebook block;
otherwise they fail with `no notebook block has focus`.

Fixtures come from `crates/tern/goldens/fixtures/notebook`. A fixture is
copied afresh, and temporary checkpoints are removed; editing it does not
change the committed fixture. Missing fixtures and filesystem errors fail
the command. `new` recreates its process-specific temporary directory, so
it is not a way to retain previous work.

Opening commands wait for notebook work to settle, then allow 300 ms of
app time for drawing. Check `tern ctl state` → `notebook_blocks[]` for
`path`, `phase`, `focused`, `mode`, `active`, `selected` and `editing`.
A failed load appears in `phase`; settling does not itself assert that the
load succeeded. Selection fails if the notebook is not loaded.

## Editing cells

| Command | Does |
| --- | --- |
| `notebook insert above\|below [code\|markdown\|raw]` | Inserts a cell above or below the selection; the default kind is `code`. |
| `notebook kind code\|markdown\|raw` | Changes the selected cells' kind. |
| `notebook delete` | Deletes the selected cells. |
| `notebook undo` | Undoes a notebook edit. |
| `notebook redo` | Redoes an undone notebook edit. |
| `notebook move up\|down` | Moves the selected cells up or down. |
| `notebook merge` | Merges the selected cells, or the active cell with the next cell when only one is selected. |
| `notebook split` | Splits the edited cell at its carets or selection boundaries; keeps editing the last part. |
| `notebook collapse input\|output` | Toggles the selected cells' input or output visibility. |
| `notebook clear [all]` | Clears selected cells' outputs, or every cell's outputs with `all`. |
| `notebook save` | Saves the notebook. |

`split` does nothing outside edit mode. A merge without a following cell
also does nothing. These editing commands settle for 300 ms of app time;
they do not wait for kernel execution to finish.

Inspect `notebook_blocks[].dirty`, `can_undo`, `can_redo` and `cells`.
Each cell reports its `index`, `kind`, `source` (first 80 characters),
`lines`, `edited`, `outputs`, `input_hidden` and `output_hidden`. Saving is
reflected by `dirty`.

## Execution and kernel

| Command | Does |
| --- | --- |
| `notebook run [all\|<n>]` | Runs the selected cells by default, all cells with `all`, or cell `<n>`. |
| `notebook interrupt` | Interrupts the kernel. |
| `notebook restart` | Restarts the kernel without a confirmation prompt. |
| `notebook wait` | Waits for every notebook's loading, execution, kernel startup and pending sheet work to settle. |

Execution uses a real kernel and its installed environment, not canned
outputs. `run <n>` fails if that cell does not exist. `run`, `interrupt` and
`restart` only allow 300 ms of app time after dispatch; follow them with
`notebook wait` before asserting results or taking a finished-output shot.

`wait` does not require notebook focus. Opening commands use the same wait:
it covers all notebook blocks, not just the focused one, and gives up after
20 seconds of real time. It does not require a kernel to have been started,
and does not wait for completion, tooltip or Help requests; their own
commands do that.

State exposes `notebook_blocks[].python` and `kernel`, and each cell's
`state` (`idle`, `queued` or `running`), `count`, `prompt`, `outputs` and
`took_ms`. A settled command is not an assertion that the executed code
succeeded; inspect the outputs.

## Find and replace

| Command | Does |
| --- | --- |
| `notebook find <text> [replace <text>]` | Opens notebook search, optionally setting its replacement text. |
| `notebook find-next` | Moves to the next match. |
| `notebook find-previous` | Moves to the previous match. |
| `notebook replace [all]` | Replaces the current match, or all matches with `all`. |
| `notebook find-close` | Closes the find bar. |
| `notebook find-option case\|word\|regex\|outputs` | Toggles case sensitivity, whole-word matching, regular expressions or searching outputs. |

Search and replacement text accept `\n` for a newline. The first separate
word `replace` after the search text introduces the replacement; an empty
replacement is allowed. Options toggle rather than set a value. These
commands settle for 300 ms of app time.

There is no dedicated find-bar field in `notebook_blocks`. Use the visible
find bar to inspect search state; replacement changes appear in `dirty`
and `cells[].source`.

## Sheets and kernel assistance

| Command | Does |
| --- | --- |
| `notebook sheet contents\|properties\|variables\|help\|none` | Shows a notebook sheet, or hides it with `none`. |
| `notebook complete` | Requests kernel completion at the edited code cell's caret and waits for the answer. |
| `notebook accept` | Accepts the selected entry in the open completion list. |
| `notebook inspect` | Requests kernel inspection in the edited code cell; repeating it expands the tooltip. |
| `notebook help <name>` | Opens the Help sheet for a name and waits for kernel help. |

`complete` fails where Tab would indent: edit a code cell with text before
the caret first. `accept` fails if no completion list is open. `inspect`
fails unless a code cell is being edited.

`complete`, `inspect` and `help` wait for all notebooks to settle and for
pending completion, inspection and Help requests to finish, then allow
300 ms of app time for drawing. Their real-time wait fails after 20
seconds. `sheet` and `accept` only settle for 300 ms; use `notebook wait`
after opening Variables when its kernel work matters.

State exposes `notebook_blocks[].sheet`, `completion`, `tooltip` and `help`.

## Examples

Run the committed execution fixture and capture its results, as in the
`notebook-run` scenario:

```text
size 1200 800
ready
notebook fixture run
zoom
notebook run all
notebook wait
shot notebook-run
```

Search the tour fixture, toggle regex matching, then close search, using
the sequence from `notebook-find`:

```text
ready
notebook fixture tour
zoom
notebook find df replace frame
notebook find-next
shot notebook-find
notebook find-option regex
notebook find (unclosed
shot notebook-find-regex
notebook find-option regex
notebook find-close
notebook select 0
notebook find kernel
shot notebook-find-markdown
```

## See also

- [Scripts](index.md): syntax, fixtures and timing.
- [Harness Commands](harness.md): keyboard input and screenshots.
- [Sessions and Blocks](sessions.md): focusing and arranging blocks.
- [Debugging](../guides/debugging.md#driving-a-window-from-a-script): driving
  a running window.
