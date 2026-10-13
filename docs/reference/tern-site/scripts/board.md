# Board Blocks

`board` commands open Markdown task boards and drive their cards, lanes,
inline editors and menus. Use them to exercise board workflows, capture the
board or list view, and check how a board reloads changes made to its file.

## Open and reload

| Command | Does |
| --- | --- |
| `board fixture <name>` | Copies a board fixture to a fresh temporary project and opens it beside the focused pane. |
| `board new` | Opens a fresh temporary project without a task file. |
| `board open <path>` | Opens a task file beside the focused pane. |
| `board write "<markdown>"` | Replaces the focused board's file on disk, then waits for the board to reload that content. |
| `board wait` | Waits until the focused board has read its file. |

Fixtures come from `crates/tern/goldens/fixtures/board/<name>.md`. Each is
copied to `TODO.md` in a temporary project named after the fixture; opening
it again resets that copy. `board new` resets its temporary project too. It
starts with Todo, Doing and Done lanes; committing the first card creates
`TODO.md`. Newly opened boards use the board view and show done cards.

Opening, `write` and `wait` wait for real file work, with the script's
20-second timeout, then settle for 350 ms. `wait` checks that the initial
read has finished, not that a later external edit has arrived. `write`
checks that the displayed disk content matches the current file. Use `\n`
in its Markdown argument for newlines. Fixture-copy and file-write errors
fail the command; a read that never reaches the required state times out.

`tern ctl state` reports each board in `board_blocks[]`: `path`, `phase`
(`loading`, `ready`, `failed` or `away`), `exists`, `open` and `done`, plus
its lanes and cards. A new unsaved board has `exists: false`.

## View, selection and menus

| Command | Does |
| --- | --- |
| `board view board\|list` | Sets the card-column or section-list view. |
| `board hide-done on\|off` | Hides or shows completed cards. |
| `board select "<text>"` | Selects the first card whose title contains the text. |
| `board lane <n>` | Selects a lane and clears the selected card. |
| `board filter ["<text>"]` | Sets the filter; no text clears it. |
| `board fold <n>` | Toggles a lane's folded section in the list view. |
| `board menu` | Opens the selected card's menu. |
| `board menu lane` | Opens the current lane's menu. |

Lane numbers are zero-based. Selection uses a case-sensitive substring,
searching lanes and cards in file order, not just the currently shown
cards. A missing match, nonexistent lane, or card menu without a selected
card fails. `fold` stores the fold even when the board view is active.

These commands target the focused board and settle for 350 ms. Commands
other than opening fail if no board has focus; a missing board view also
fails. There is no desktop-only or headless-only restriction on this family.

State fields are `view`, `hide_done`, `cursor` (the selected title), `lane`,
`filter` and `lanes[].folded`. Each lane also reports `title`, `complete`,
`shown` and `cards` (each card's `text` and `done`). Menu contents can be
inspected with the control command `menus`.

## Inline editing and dragging

| Command | Does |
| --- | --- |
| `board type ["<text>"]` | Replaces the current inline editor's text; no text empties it. |
| `board commit` | Commits the current inline edit, like Enter. |
| `board drag <lane> <slot> [hold] "<card>"` | Drags the first card whose title contains the text into the destination lane and slot. |

Start an inline edit with a board action below. `type` and `commit` fail
when no inline edit is under way; they settle for 350 ms rather than
waiting for a separate disk-read condition.

Drag lane and slot numbers are zero-based. Slots count the destination's
shown cards, excluding the dragged card. A slot past the last card appends
it. Without `hold`, the drag drops the card; with `hold`, it remains lifted
for a screenshot. A missing card, missing rendered card or nonexistent
lane fails. Dragging settles for 350 ms. Moving to or from a done lane
updates the card's completion state.

State exposes `editing`, `dragging`, the resulting `lanes[].cards`, and
`can_undo` / `can_redo`.

## Board actions

`board key <id>` invokes an action directly: use the identifiers below,
not a physical key name or a `board.` prefix. Unknown identifiers fail.
Actions settle for 350 ms. Actions that need a selected card generally do
nothing without one; unavailable undo/redo or movement at an edge also
does nothing.

| Command | Does |
| --- | --- |
| `board key up\|down` | Selects the card above or below. |
| `board key left\|right` | Selects a card in the previous or next lane. |
| `board key first\|last` | Selects the first or last card. |
| `board key move_up\|move_down` | Moves the selected card within its lane. |
| `board key move_left\|move_right` | Moves the selected card to the previous or next lane. |
| `board key toggle` | Marks the selected card done or open again. |
| `board key edit` | Starts editing the selected card's title. |
| `board key new_below\|new_above` | Starts a new card below or above the selection, or in the current lane. |
| `board key delete` | Deletes the selected card. |
| `board key undo\|redo` | Undoes or redoes a board change. |
| `board key details` | Toggles the selected card's notes and subtasks panel. |
| `board key filter` | Focuses the filter field. |
| `board key switch_view` | Toggles the board and list views. |
| `board key hide_done` | Toggles hiding completed cards. |
| `board key clear` | Clears details, the filter or selection. |
| `board key new_lane` | Starts a new lane after the current lane. |
| `board key rename_lane` | Starts editing the current lane's title. |
| `board key move_lane_left\|move_lane_right` | Moves the current lane left or right. |
| `board key delete_lane` | Deletes the current lane. |
| `board key done_lane` | Toggles whether the current lane is a done lane. |
| `board key open_markdown` | Opens the board's file in a file block beside it. |

Use `board type` and `board commit` after card or lane creation and rename
actions. The action results appear in `cursor`, `lane`, `editing`,
`details`, `view`, `hide_done`, `filter`, `done_lane`, `lanes`, `can_undo`
and `can_redo` in `board_blocks[]`. `open_markdown` focuses a file block;
focus the board again before sending more board commands.

## Examples

Create the first task in a fresh project:

```text
ready
board new
zoom
shot board-new
board key new_below
board type "Sketch the onboarding flow"
board commit
shot board-new-created
```

Show a fixture as a list, fold Backlog and then hide completed tasks:

```text
ready
board fixture launch
zoom
board view list
board fold 0
board select "Notarize"
shot board-list
board hide-done on
shot board-list-hide
```

## See also

- [Scripts](index.md): running scripts, timing and fixture setup.
- [File Blocks](file.md): driving the Markdown file opened from a board.
- [Control Commands](control.md): inspecting state and menus.
- [Harness Commands](harness.md): pointer input and screenshots.
- [Debugging](../guides/debugging.md): driving a window from a script.
