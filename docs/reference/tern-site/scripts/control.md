# Control Commands

Control commands inspect and drive a running Tern window or headless server
through `tern ctl`. Use them to inspect plugin UI, check app state, restyle a
window without rebuilding, or measure rendering. Unlike ordinary scenario
commands, most inspections reply immediately rather than settling animations.

## Connection and replies

| Command | Does |
| --- | --- |
| `tern serve [--control <endpoint>] [--out <dir>]` | Starts a headless control server. |
| `tern --control <endpoint> [ARGS]` | Opens a desktop window with a control endpoint. |
| `tern ctl [--control <endpoint>] <command...>` | Sends one line and prints its JSON reply. |
| `tern ctl [--control <endpoint>] --file <scenario>` | Sends each nonblank, non-comment line over one connection, waiting for its reply before sending the next. |

An endpoint is a socket path or a numeric TCP port on `127.0.0.1`. Port `0`
asks the server to choose a free port. The default is `/tmp/tern.sock` on
Unix and `tern.sock` in the user's temporary directory on Windows. Windows
socket endpoints require Windows 10 1803 or later. Several clients may
connect; commands run one at a time.

The wire protocol is one command line followed by one JSON reply line:

- No result: `{"ok":true}`.
- Object result: its fields are merged into `{"ok":true,...}`.
- Any other result: `{"ok":true,"value":...}`.
- Failure: `{"ok":false,"error":"..."}`.

`--file` prints each command and up to 400 characters of its reply, and
stops at the first unsuccessful reply. The underlying reply is not truncated.
Harness waits and app-command settles pace the file; inspection commands do
not add a wait. Control-only commands are not accepted by `tern shot`.

Control syntax differs from the [scenario syntax](index.md#syntax):
`dump`, `tree` and `webreports` take the entire remaining line as a selector,
without removing quotes. `webcall` takes everything before the first `{` as
its selector and parses the remainder as JSON. `css` splits on whitespace;
its names and paths cannot contain spaces. Do not add script quotes or
trailing comments to these arguments.

## Inspecting a window

| Command | Does |
| --- | --- |
| `dump [<selector>]` | Returns the screenshot layout JSON: element paths, boxes and computed geometry; a selector limits it to matches with geometry. |
| `tree [<selector>]` | Returns the visible element tree, or visible matches with text, values, focus and web-view address/title. |
| `pick <x> <y>` | Returns the element at a viewport point and its geometry and relevant styles. |
| `state` | Returns Tern's app state. |
| `stats` | Returns clocks, frames, document size, viewport/scale, pointer, resolved cursor, animations, caret, next timer, outgoing drag and web views. |
| `layers` | Returns `count` and `layers` in paint order, with depth, bounds, opacity, transform, clip, mask, filters and backdrop effects. |
| `a11y` | Returns the accessibility tree, rooted at the window. |
| `menus` | Returns native menu bar, Dock, tray and open context-menu rows. |
| `system` | Returns system integration state and recent one-shot requests. |

Coordinates and accessibility bounds use viewport CSS pixels. `pick` takes
exactly two numbers. Invalid selectors fail the reply. Bare commands reject
arguments; `a11y` with arguments instead performs a harness accessibility
action, documented in [Harness Commands](harness.md).

Accessibility nodes have `id`, `role`, and optional `name`, `description`,
`value`, `placeholder`, `states`, `level`, `posinset`, `setsize`, `bounds`,
`actions` and `children`. Empty fields and text-field text runs are omitted.
Menu actions include ids, labels, enabled/checked state and accelerators;
submenus contain `items`. `system` includes dialogs, notifications, badge,
progress, title, edited/represented document, recent documents, shortcuts,
sleep, secure input, accent, displays, secrets and a request log. Headless
system integrations are simulated; inspecting them does not answer dialogs.

These snapshots describe UI and host state, not separate Tern `state` fields.
For example, use `stats` for the pointer or outgoing drag, `menus` for native
menus, and `system` for pending dialogs.

### Tern state fields

`state` merges these top-level fields into the successful reply. Closed or
inactive features may be `null` or empty.

| Fields | Describes |
| --- | --- |
| `tabs`, `focused`, `panes`, `sessions`, `decks`, `tabs_out` | Tabs, focused terminal, pane grid dimensions and session/navigation layout. |
| `palette`, `palette_scope`, `find`, `menu`, `picker`, `pane_drag`, `focused_element` | Open navigation UI, search and element focus. |
| `theme_dark`, `theme_light`, `theme_preview`, `theme` | Selected themes and preview. |
| `layout`, `tab_orientation`, `tab_badges`, `status_bar`, `pane_headers` | Pane and tab presentation. |
| `material`, `opacity`, `blur`, `glass_hud`, `density`, `viewport`, `csd` | Window appearance, viewport and decorations. |
| `font`, `font_family`, `face`, `faces` | Font size, requested family and resolved faces by style. |
| `inbox`, `hosts`, `prefs`, `peek`, `pips`, `pip_commits`, `files` | Feature-specific state. |
| `file_blocks`, `task_manager_blocks`, `screen_blocks`, `sqlite_blocks`, `board_blocks`, `profile_blocks` | Block-specific state. |
| `quicklook`, `lightbox`, `term_link`, `gate`, `melt` | Preview, link, account gate and screen-effect state. |
| `git_blocks`, `notebook_blocks`, `carly` | Desktop-only block and assistant state; absent on web and iOS. |
| `update` | Update state; absent on iOS. |

`focused` includes the pane id, label, working directory, git status, running
command, busy state, last command/status, exit/error state, prompt readiness
and selected terminal text. `viewport` reflects resizing; CSS patches,
profiling and web calls have no dedicated Tern state field.

## CSS patches

| Command | Does |
| --- | --- |
| `css` | Lists `sheets` with `name` and `rules`, in cascade order. |
| `css <name> <path>` | Reads a CSS file and replaces the named sheet, or appends a new patch. |
| `css <name>` | Drops every sheet with that name, including a built-in. |

Paths are relative to the running app's working directory, not the client's.
Replacing a sheet keeps its cascade position; a new sheet goes last and wins
against equal-specificity earlier rules. Loading replies with `sheet`,
`rules` and `errors` (`file`, `line`, `column`, `message`). Invalid CSS rules
are dropped but the remaining rules apply: parse errors do not make the
reply unsuccessful. An unreadable file does. Dropping replies with `dropped`.
A successful patch schedules a live frame or draws a headless frame; it does
not wait for animations to finish. Inspect `css` or `dump`, not `state`, to
check the patch.

## Measuring frames and traces

| Command | Does |
| --- | --- |
| `perf` | Returns frame timing since the last reset. |
| `perf on` | Starts a fresh collection, with GPU timestamps when available. |
| `perf off` | Stops headless timing; a desktop window keeps CPU timing. |
| `perf reset` | Restarts the existing collection. |
| `perf mark` | Starts counting subsequent frames for `perf since`. |
| `perf since` | Returns timings since the mark, including `settled`. |
| `trace` | Returns `recording`, a trace path or `null`. |
| `trace start [<directives>]` | Starts a process-wide Chrome trace and returns `path`. |
| `trace stop` | Finishes the trace and returns `path`, `events` and `bytes`. |

Headless timing must be enabled with `perf on` before `perf`, `perf mark` or
`perf since`; `perf reset` does not enable it. Live `on`, `off` and `reset`
reset the collection and reply with `gpuTiming`; `off` disables GPU timing.
`perf since` fails without a mark. Its `settled` is `null` until a frame asks
for no more frames, then reports accumulated frame counts, time and work up
to that frame. It observes settling; it does not wait for it.

Trace directives filter recorded spans/events; without them, the default
records Stencil spans, coarse git spans and dependency warnings. For example,
`trace start stencil_ui=trace,warn`.
Open the resulting trace in `ui.perfetto.dev`. Starting while already
recording, invalid directives and file errors fail; stopping without a
recording fails. These measurements are separate replies, not Tern state.

## Viewport and lifetime

| Command | Does |
| --- | --- |
| `resize <width> <height>` | Sets headless viewport or live window content size without a settle. |
| `thaw` | Resumes a document timeline stopped by `freeze-anims` or `motion-at`. |
| `quit` | Stops the headless server or closes the live app. |

`resize` requires exactly two numbers, both at least 1 CSS pixel. Headless
resizing preserves device scale and draws a frame. At a control endpoint it
means window resizing, not Tern's pane-resizing command. `thaw` is a harness
command, not a control-only inspection; it takes no arguments. Use `stats`
for timeline/frame activity and `state.viewport` for viewport dimensions.

This sequence follows the bell-ripple golden; send it with `ctl --file` to
capture a held effect and its resting frame:

```text
ready
freeze-anims
feed "goldens/fixtures/bell.txt"
motion-at 120
shot bell-held
thaw
wait 1300
shot bell-rest
stats
```

## Driving web pages

| Command | Does |
| --- | --- |
| `webcall <selector> <json>` | Calls the page in the first matching element that embeds a web view; replies with its answer. |
| `webreports <selector>` | Returns recent driven-page reports in `reports`, oldest first. |

Both require a live window; headless sessions fail with “a headless session
shows no pages”. Missing pages or invalid selectors fail. `webcall` waits
for the native page's answer in real time, with Tern's 20-second condition
timeout; its answer goes only to the control client. `webreports` retains
only the last few hundred reports across pages. Reports include messages,
frames, dialogs, choosers, downloads, responses, committed/loaded navigation
and blocked requests. Use these replies, not `state`, to inspect calls.

The JSON object requires `op`. Optional fields may be absent or `null` unless
noted. Unknown operations, invalid names, missing required fields or wrong
field types fail. The following lists every accepted operation; field names
in parentheses are optional.

| Command | Does |
| --- | --- |
| `webcall <selector> {"op":"eval","function":<string>}` | Evaluates a function expression; optional `args` array (default `[]`), `world` (`page\|isolated`, default `page`) and `frame` string. Replies with `value`, or no value for JavaScript `undefined`. |
| `webcall <selector> {"op":"capture"}` | Captures an image; optional `rect` (`x`, `y`, `width`, `height`), `full` (false), `scale` (1), `format` (`png\|jpeg\|jpg`, default `png`) and `quality` (80). JPEG quality rounds and clamps to 1–100. Replies with base64 `data`, `mime`, `width`, `height`. |
| `webcall <selector> {"op":"pdf"}` | Replies with base64 `data` and `mime`. |
| `webcall <selector> {"op":"input","events":<array>}` | Injects page input using the event forms below. |
| `webcall <selector> {"op":"edit","action":<copy\|cut\|paste\|selectAll\|undo\|redo>}` | Performs a page editing action. |
| `webcall <selector> {"op":"cookies"}` | Replies with a `cookies` array. |
| `webcall <selector> {"op":"setCookie","cookie":<object>}` | Sets a cookie with required `name`, `value`, `domain`; optional `path` (`/`), `expires` (Unix seconds), `httpOnly` (false), `secure` (false), `sameSite` string. |
| `webcall <selector> {"op":"deleteCookie","name":<string>,"domain":<string>}` | Deletes a cookie; optional `path` defaults to `/`. |
| `webcall <selector> {"op":"scripts","scripts":<array>}` | Replaces injected scripts: each requires `source`; optional `world` (`page\|isolated`, default `page`), `frames` (`main\|all`, default `main`), `at` (`start\|end`, default `start`). |
| `webcall <selector> {"op":"agent"[,"value":<string\|null>]}` | Overrides the user agent, or clears the override. |
| `webcall <selector> {"op":"media"[,"value":<string\|null>]}` | Overrides media, or clears the override. |
| `webcall <selector> {"op":"appearance"[,"value":<dark\|light\|null>]}` | Overrides page appearance, or clears the override. |
| `webcall <selector> {"op":"dialogs","report":<bool>}` | Enables or disables dialog reporting. |
| `webcall <selector> {"op":"dialog","accept":<bool>}` | Answers a page dialog; optional `text` supplies prompt text. |
| `webcall <selector> {"op":"files"[,"paths":<array\|null>]}` | Supplies chooser paths, or cancels. |
| `webcall <selector> {"op":"downloads"[,"dir":<string\|null>]}` | Sets or clears the download directory. |
| `webcall <selector> {"op":"allow"[,"hosts":<array\|null>]}` | Sets or clears the allowed-host list. |
| `webcall <selector> {"op":"credentials"[,"username":<string>,"password":<string>]}` | Sets authentication credentials; both absent/null clears them, only one fails. |
| `webcall <selector> {"op":"insecure","value":<bool>}` | Changes insecure-connection permission. |

Operations without a listed result return only success. Page input accepts:

- `{"type":"mouse","action":"move|down|up","x":N,"y":N}`;
  optional `button` is `left|right|middle` (default `left`), `clicks` defaults
  to 0 for move and 1 otherwise, and clamps/truncates to 0–16.
- `{"type":"wheel","x":N,"y":N}` with optional `dx`, `dy` (both 0).
- `{"type":"key","action":"down|up","key":"..."}` with optional
  `code` and `text` strings.
- `{"type":"text","text":"..."}`.

Mouse, wheel and key events accept `mods`, an array of `shift`,
`ctrl|control`, `alt|option` and `meta|cmd|command` (default empty).
Native page capabilities vary by platform; parsing a call does not guarantee
that the host supports it. Tern browser operations such as `snapshot` and
`act` are not accepted here; use [Browser Blocks](browser.md).

## See also

- [Scripts](index.md): running, fixtures and timing.
- [Harness Commands](harness.md): input, screenshots and timeline controls.
- [Browser Blocks](browser.md): Tern's browser-specific driver.
- [Debugging](../guides/debugging.md#driving-a-window-from-a-script): plugin UI workflows.
