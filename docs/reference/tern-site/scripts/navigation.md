# Tabs and Navigation

These commands arrange tabs and panes, change their chrome and drive the
style and path pickers. Use them to set up a workspace, capture navigation
states or move a pane without clicking through menus.

## Tabs and chrome

| Command | Does |
| --- | --- |
| `tabs [horizontal\|vertical\|toggle]` | Sets the tab orientation, or toggles it when omitted. |
| `tabs autohide on\|off` | Hides or keeps the vertical tab column at the window's edge. |
| `filter ["<query>"]` | Sets the vertical tab list's filter; omit the query to clear it. |
| `status-bar [on\|off]` | Shows or hides the status line; omission toggles it. |
| `pane-headers never\|split\|always` | Shows no pane headers, headers only in split tabs, or headers on every pane. |
| `style rail\|float\|tiles\|studio\|glass\|clear\|solid\|islands\|compact` | Keeps a layout, material or density choice. |
| `cross-session-click switch\|stay` | Makes a single press on another session's tab switch to it or keep the current session. |

`tabs` settles for 900 ms, including the tabs' travel. The other commands
settle for 450 ms. `style` choices are case-insensitive and change only the
chosen category. With `cross-session-click stay`, a double click or an
explicit selection still switches sessions.

State exposes `tab_orientation`, `status_bar`, `pane_headers`, `layout`,
`material` and `density`. `pane_headers` uses the labels `Never`, `When
split` and `Always`. There is no dedicated state field for the filter,
autohide or cross-session-click setting; inspect the visible list with
`tree` or `dump`, and session selection with `sessions`.

## Pickers and paths

| Command | Does |
| --- | --- |
| `interface-style` | Opens Change interface style. |
| `picker up\|down [<n>]` | Moves the open picker's highlight by a count of rows, previewing style choices. |
| `picker enter` | Chooses the highlighted row. |
| `picker split` | Chooses with the split action, like Command–Enter. |
| `picker esc` | Cancels the picker, restoring an uncommitted style preview. |
| `goto ["<path/query>"]` | Opens Go to directory at the focused pane's directory. |
| `insert-path ["<path/query>"]` | Opens Insert path at the focused pane's directory. |

The count defaults to 1. It is a signed integer: a negative count reverses
its direction and zero leaves the highlight in place. Stepping wraps around
the rows. `picker` fails if no picker is open; choosing with no matching row
does nothing.

In a path query, slash-separated segments descend as typing `/` would;
the final segment is the fuzzy query. An omitted query starts with an empty
filter. `goto` lists directories; choosing opens a new tab on the focused
pane's host, or a split with `picker split`. `insert-path` also lists files
and inserts the chosen path into the original pane at its cursor. Choosing
the parent row goes up instead of closing the picker.

Both path commands fail if no pane has focus. They wait in real time for
the directory listing and background walk, then settle for 450 ms. The
script's 20-second real-work timeout applies. Other picker commands settle
for 450 ms; choosing a directory does not itself wait for a shell prompt,
so use `ready` before running a command in the new shell. These commands
also browse on remote hosts; they are not desktop-only.

State's `picker` is null when closed. When open it reports `mode`, `query`,
`dir`, `rows`, `walked` and `selected`. A style picker uses mode `style`;
path pickers use `goto` and `insert`. Style previews also appear in
`layout`, `material` and `density`.

```text
ready
goto ""
shot goto-dir
goto "crates/tern/"
shot goto-dir-descend
goto "crates/tern/srcview"
shot goto-dir-fuzzy
picker esc
insert-path "crates/tern/sessrs"
shot insert-path
picker enter
shot insert-path-typed
```

This is the navigation sequence from the `goto-dir` golden, run from a
checkout's root.

## Moving panes

| Command | Does |
| --- | --- |
| `drag-pane <n> [<m> left\|right\|up\|down\|center\|tl\|tr\|bl\|br]` | Starts dragging pane `n`, optionally hovering over pane `m`'s drop zone. |
| `move-pane left\|right\|up\|down` | Moves the focused pane in that direction. |
| `move-pane tab <n> ["<session>"]` | Moves the focused pane to a numbered tab in the current or named session. |
| `move-pane new-tab` | Moves the focused pane into a new tab. |
| `move-pane session "<session>"` | Moves the focused pane into a new tab in that session. |

Pane numbers are 1-based reading order in the active tab. Tab numbers are
1-based within the target session; session names are case-insensitive.
`center` swaps panes; `tl`, `tr`, `bl` and `br` float a pane in the target's
top-left, top-right, bottom-left or bottom-right corner. `drag-pane` only
starts the drag and sets its hover overlay. Complete it with the harness's
`drop <x> <y> text "tern-pane:<id>" move`, using the dragged pane's ID from
state, or cancel with `drag-end`.

A missing pane, tab or named session fails. Moving to a tab fails when the
pane is already there or belongs to another host. Moving to a session fails
when it is already that tab's only pane in the target session, or the target
is on another host. Moving to a new tab fails for a tab's only pane. The
three tab/session forms require a focused pane and keep it focused after
the move. Directional moves have no such explicit failure result. All
these commands settle for 450 ms.

State's `pane_drag` reports the dragged `pane` ID and `over` target/zone,
or null when no drag is active. Moves change `tabs`, `panes`, `focused` and,
when crossing sessions, `sessions`.

## Running labels and tab history

| Command | Does |
| --- | --- |
| `running "<command line>"` | Makes the focused pane report a command as running without starting it. |
| `tidy` | Names the active tab after its panes' programs, focused pane first. |
| `previous-tab` | Shows the previously viewed tab, switching sessions if needed. |

`running` is useful for captures of programs a headless run cannot start.
It requires a nonempty command line and a focused pane. It changes the
pane's running/busy state, not its terminal output. `tidy` uses up to two
distinct program labels joined by ` · `; renaming the tab replaces that
name. `previous-tab` fails when no previous tab remains open; repeating it
returns to the tab you just left. These commands settle for 450 ms.

State reflects these changes in `focused.running`, `focused.busy`, and
`tabs` (`title`, `busy`, `active`); `sessions[].current` reflects a session
switch. There is no separate tab-history field.

```text
ready
running "btop"
tab new
running "claude"
split right
tab new
running "nvim notes.md"
split down
running "lazygit"
shot deck
tabs vertical
shot deck-vertical
```

This uses the program labels and pane setup from the `deck` golden.

## See also

- [Terminal and Panes](terminal.md): creating tabs, splits and shell commands.
- [Sessions and Blocks](sessions.md): creating and selecting sessions.
- [Harness Commands](harness.md): input, drops and screenshots.
- [Control Commands](control.md): inspecting state and the visible tree.
- [Debugging](../guides/debugging.md#driving-a-window-from-a-script): running
  scripts against a window.
