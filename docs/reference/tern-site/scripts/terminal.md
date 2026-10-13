# Terminal and Panes

These commands drive shells, pane splits, tabs and the terminal's appearance.
Use them to arrange a window, wait for output, exercise attention indicators
or replay a plugin surface without running the program that produced it.

## Shells and waits

| Command | Does |
| --- | --- |
| `ready` | Waits for every visible program pane in the active tab to reach its shell prompt or exit. |
| `git-read` | Waits for the focused pane's directory to have its git information read. |
| `link-read` | Waits for the path under the pointer to finish its existence check. |
| `run "<command>"` | Writes the command and Enter to the focused shell. Replaces every `{fixtures}` with the file fixtures directory. |
| `expect "<text>"` | Waits for a substring on one visible terminal row in the focused pane. |
| `completing` | Waits for the completion popover to open. |

`run` gives output 1.2 seconds of real time, then settles for 100 ms; it does
not wait for the command to finish. Follow it with `expect` or `ready` when
completion matters. `expect` does not search across rows or through offscreen
scrollback. `run` fails without a running shell; `expect` fails without a
focused terminal. An empty active tab satisfies `ready`, and no focused pane
satisfies `git-read`. Real-work waits fail after 20 seconds.

State: `focused.prompt`, `focused.running`, `focused.last`, `focused.exited`
and `focused.git` describe the shell; `term_link` describes the hovered link.
There is no separate completion or pending-wait field.

## Panes, tabs and menus

| Command | Does |
| --- | --- |
| `split right\|down` | Splits the focused pane horizontally or vertically. |
| `close` | Closes the focused pane. |
| `zoom` | Toggles zoom on the focused pane. |
| `equalize` | Evens out the active tab's splits. |
| `focus left\|right\|up\|down\|next\|prev` | Focuses a neighboring pane or cycles through panes. |
| `resize left\|right\|up\|down` | Moves a split boundary to resize the focused pane. |
| `tab new\|next\|prev\|close\|<n>` | Creates, cycles, closes or selects a tab; `<n>` is a positive, one-based number. |
| `rename "<name>"` | Renames the active tab. |
| `palette ["<query>"]` | Opens the command palette with an optional query. |
| `find "<query>"` | Opens search in the focused pane's scrollback. |
| `context pane\|tab` | Opens the focused pane's menu or the active tab's menu. |
| `layout rail\|float\|tiles\|studio` | Switches the window layout. |

Layout names are case-insensitive. Pane and tab operations settle after
visible shell prompts are ready; a newly opened shell can therefore delay the
next command. `resize` here changes a pane, not the window's viewport: see
[Control Commands](control.md) for `tern ctl resize W H`.

State: `panes` gives terminal dimensions, `focused.id` identifies focus,
`tabs` gives titles, pane counts, active and zoomed flags, and `decks` describes
arrangement. `layout`, `palette`, `palette_scope`, `find` and `menu` reflect
the corresponding UI.

```text
ready
split right
run "git status"
expect "On branch"
focus left
run "ls"
shot split-status
```

## Fonts and window controls

| Command | Does |
| --- | --- |
| `font <px>` | Sets the terminal font size to a nonnegative whole number, clamped to the supported range. |
| `font-family ["<families>"]` | Sets regular terminal font families; no argument or an empty string restores built-in faces. |
| `font-family bold\|italic\|bold-italic "<families>"` | Sets a styled terminal face; an empty string inherits regular families. |
| `font-weight <n>` | Sets terminal font weight, clamped to 100–900. |
| `adjust-cell-height <px>\|<n>%` | Adds whole pixels or a finite percentage to terminal row height. |
| `adjust-cell-height ""` | Resets the row-height adjustment. |
| `ui-font ["<families>"]` | Sets UI font families; no argument or an empty string restores the built-in face. |
| `code-font ["<families>"]` | Sets code font families; no argument or an empty string restores the built-in face. |
| `decorations system\|lights\|buttons` | Selects system window controls, Tern traffic lights or title-bar buttons. |

Quote a family list as one argument, for example `font-family "A, B"`.
Styled forms require both the style and a family string. Pixel adjustments
accept signs (`+3`, `-1`); percentages also accept fractions (`-12.5%`). The
resulting row height is rounded and limited to half through three times the
unadjusted height. Font size and weight take unsigned whole numbers.

State: `font`, `font_family`, `face` and `faces` expose terminal size and the
requested and resolved families. `csd` indicates client-side decorations, but
does not distinguish lights from buttons. Weight, row-height adjustment and
UI/code family settings have no dedicated top-level state fields.

## Themes, scrolling and copying

| Command | Does |
| --- | --- |
| `theme [dark\|light] "<name>"` | Keeps a named theme for its own appearance, or for the explicitly supplied appearance. |
| `themes ["<name>"]` | Opens the theme picker, previewing the named theme when supplied. |
| `scroll <lines>` | Scrolls the focused terminal back by a signed whole number of lines; negative values move toward the live end. |
| `copy` | Copies the focused pane's selection and shows copy feedback. |

A single argument to `theme` is always a name, even `dark` or `light`.
Changing one appearance's theme preserves the other appearance's choice.
Unknown theme names fail. `themes` with multiple arguments opens the picker
without selecting a name; `copy` ignores arguments.

Inline surfaces scroll with the terminal. For a surface cover or an overlay
list that scrolls independently, use `move X Y` followed by `wheel DX DY`.
`scroll` fails without a focused pane; a pane without a terminal does not
scroll. `copy` without focus does nothing.

State: `theme_dark`, `theme_light`, `theme_preview` and `theme` show theme
choices and preview. `focused.selection` exposes selected terminal text;
there is no top-level scroll-position or clipboard field.

## Attention and overview

| Command | Does |
| --- | --- |
| `alert bell ["<detail>"]` | Records a bell on the focused pane; omitted or empty detail uses its label. |
| `alert done <status> "<command>" [<seconds>]` | Records a command's completion, with signed exit status and optional nonnegative whole seconds. |
| `alert exited <status>` | Records a program exit with a signed status. |
| `alert waiting "<message>"` | Records a request for attention. |
| `alert agent-done` | Records an agent completion using the focused pane's label. |
| `inbox` | Opens the attention inbox. |
| `inbox go` | Goes to the selected entry's pane. |
| `inbox clear` | Clears all entries. |
| `inbox close` | Closes the inbox. |
| `peek [strip\|mission\|close]` | Opens the tab strip or Mission Control, or returns to the terminal. Defaults to `strip`. |
| `melt [<progress>]` | Closes the current session and plays its close effect to progress 0–1. Defaults to 1. |

`alert` requires a focused pane and does not run the named command or exit
its program. `inbox go` fails if the inbox is closed or has no selection.
`peek` opens at rest, without transition motion, and waits for its overview
capture to be ready. `melt 0` still closes the
session; the argument controls only the effect's timeline. Progress is rounded
to thousandths, and reduced motion uses a fade instead of a melt.

State: `inbox` gives entries and selection, `tabs[].alert` gives tab attention,
`peek` describes overview level and cards, and `melt` gives the active effect
and progress. `sessions` reflects the closed session.

## Output and surface replay

| Command | Does |
| --- | --- |
| `feed "<path>"` | Prints a text fixture into the focused pane as terminal output. |
| `surface-play "<path>" [from <frame>] [until <frame>] [paced [<times>]]` | Replays a JSON-lines surface recording, optionally bounded by frames or at its recorded pace. |

These commands read an existing path directly, otherwise resolve it under the
fixture root. `feed` reads UTF-8, converts line endings to CR LF, removes the
last newline and expands literal `\e` and `\a` to Escape and Bell. Both
commands restart the focused pane with a silent replay program when necessary,
then wait for it to listen; they fail without focus or if the file cannot be
read. Replay is unavailable on WebAssembly builds.

A frame is an unsigned sequence number (`3`) or a surface ID plus sequence
(`chat#3`). `from` excludes the named frame and requires an existing replay
in the focused pane; `until` includes its frame. Options can appear in any
order, and a repeated option replaces its earlier value. Invalid recording
JSON fails with a line number.

Without `paced`, replay feeds output at once. `paced` defaults to 1×;
`paced 2` plays twice as fast. The multiplier must be finite and positive.
Paced replay starts without waiting for its last message: use `wait MS` to
advance document time. A second paced recording in the same pane fails while
one is still playing; closing its pane stops playback.

State exposes the resulting pane through `focused` and `panes`, but has no
recording-progress field. Use `tree` or `dump` to inspect rendered surfaces.

```text
ready
surface-play "goldens/fixtures/omp-chat.jsonl" until 3
wait 300
shot chat
```

## Fixture plugins

| Command | Does |
| --- | --- |
| `plugins fixtures` | Loads the source tree's test plugins and reloads their host and window entries. |
| `plugins run <action>` | Runs a named keymap action, including a plugin action such as `plugin.hello.ask`. |
| `plugins expect "<text>"` | Waits for text in a surface belonging to the focused terminal. |

Fixture plugins live in `crates/plugins/fixtures`. Loading them requires the
fixture root and fails when the window is attached to a session daemon, whose
plugins are managed separately. The command restores plugin enable/disable
choices from saved settings, even in a headless run. Invalid action syntax
fails. `plugins expect` waits on surface content rather than terminal rows,
and times out after 20 seconds if the text never appears.

There is no dedicated plugin state field. Inspect the rendered surface with
`tree` or `dump`, and use `plugins expect` to wait for its content.

## See also

- [Scripts](index.md): running, quoting, fixtures and timing.
- [Harness Commands](harness.md): input, screenshots and document time.
- [Tabs and Navigation](navigation.md): navigation and pane arrangement.
- [Sessions and Blocks](sessions.md): session and block operations.
- [Debugging](../guides/debugging.md): driving plugins from scripts.
- [Command Line](../reference/cli.md): managing installed plugins.
