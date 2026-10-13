# Harness Commands

Harness commands drive the window itself: input, viewport, time, capture and
simulated system events. Use them alongside Tern commands to reproduce a user
interaction, capture a transition or supply events that a headless window
cannot receive from the operating system.

## Viewport, time and capture

| Command | Does |
| --- | --- |
| `size <W> <H> [scale]` | Sets the viewport in CSS pixels; optionally sets headless device scale. |
| `wait <MS>` | Lets time pass, in milliseconds. |
| `freeze-anims` | Stops the document timeline, including timers. |
| `thaw` | Resumes the stopped timeline. |
| `motion-at <MS>` | Stops time and seeks every running animation to that many milliseconds into its own run. |
| `shot <name>` | Writes a PNG and matching layout JSON. |

Omitting `scale` preserves the current scale. It must be positive; live
windows ignore it. `size` settles the resize; the control command `resize`
does not. `wait` advances simulated time headlessly and waits real time in a
live window. It is not a wait for a shell, file or network result: use the
relevant family's wait command for those. Real-work waits described in the
[overview](index.md#timing) fail after 20 seconds.

`motion-at` requires a nonnegative time. Put `freeze-anims` before the action
that starts a motion if an intervening wait would otherwise finish it.
Frozen time does not fire end-of-motion timers. `shot` names may contain only
ASCII letters, digits, `_`, `.` and `-`, and must not be empty. Captures go to
the runner's output directory.

State: `viewport` reports size and scale; `panes` reports terminal dimensions.
`melt` reports a playing screen effect and its progress. There is no general
animation-clock or screenshot field in `tern ctl state`; use `stats` for
clock information and the capture's reply for its paths.

## Pointer and scrolling

| Command | Does |
| --- | --- |
| `move <X> <Y>` | Moves the pointer, including while a button is held. |
| `down [X Y]` | Presses the primary button, optionally moving first. |
| `up [X Y]` | Releases the primary button, optionally moving first. |
| `click <X> <Y> [right] [ctrl] [meta] [alt] [shift]` | Clicks coordinates with an optional secondary button and modifiers. |
| `click <selector> [right] [ctrl] [meta] [alt] [shift]` | Clicks the center of the first matching element. |
| `dblclick <X> <Y> [right] [ctrl] [meta] [alt] [shift]` | Clicks twice, with the second press marked as a double-click. |
| `dblclick <selector> [right] [ctrl] [meta] [alt] [shift]` | Double-clicks the first matching element. |
| `hover <selector>` | Moves to the center of the first matching element. |
| `wheel <DX> <DY> [ctrl] [meta] [alt] [shift] [lines] [phase <phase>] [momentum <phase>]` | Scrolls at the current pointer. |

Coordinates are viewport CSS pixels. Without coordinates, `down` and `up`
use the current pointer. Click modifiers and `right` may appear in any order
at the end; quote selectors whose final word would otherwise be an option.
Click and hover selectors may also span several unquoted words, which are
joined with spaces. A selector must be nonempty and match an element.
`hover` does not itself wait for a tooltip: follow it with `wait 700`.

Wheel deltas are precise pixels by default; `lines` selects line deltas.
Both phases default to `none`. Each accepts `none`, `began`, `changed`,
`ended`, `canceled` or `maybegin`; wheel options may appear in any order.
Input dismisses an open context menu before being delivered.

State: `focused_element` identifies DOM focus, `focused.selection` reports
terminal selection and `pane_drag` reports pane dragging. Pointer position
and wheel phases are not state fields; inspect `stats` for the pointer.

## Keyboard and composition

| Command | Does |
| --- | --- |
| `key <combo>` | Presses and releases a key combination. |
| `keydown <combo>` | Sends only the key press. |
| `keyup <combo>` | Sends only the key release. |
| `type <text>` | Types text into the focused element. |
| `preedit <text>` | Supplies IME composition text, with its cursor at the end. |
| `commit <text> [combo]` | Commits IME text, optionally with the key that ends composition. |
| `window-focus on\|off` | Makes the window gain or lose key-window focus. |

Text and combinations are single arguments: quote text containing spaces.
Key names use forms such as `Meta+k`, `Shift+Tab`, `Escape`, `ArrowLeft`,
`F1` and `[`. Unknown keys or modifiers fail. `preedit ""` ends composition.
With a combination, `commit` commits as that key goes down and passes the
key on, as an IME does for Enter, Tab or Escape. `type` sends character input,
not shell commands; `run` handles a command and its prompt wait.

State: `focused_element`, `focused`, `palette`, `find` and `file_blocks`
reflect the receiving control's changes. There is no separate IME or
key-window-focus field.

## Gestures and touch

| Command | Does |
| --- | --- |
| `pinch <X> <Y> <scale> [steps N]` | Sends a phased pinch anchored at the point. |
| `rotate <X> <Y> <degrees> [steps N]` | Sends a phased rotation, positive clockwise. |
| `smart-magnify <X> <Y>` | Sends a two-finger double tap. |
| `swipe left\|right [X Y] [discrete]` | Sends a two-finger navigation scroll, or one discrete three-finger swipe. |
| `swipe up\|down [X Y] [discrete]` | Sends a three-finger swipe, optionally discrete. |
| `swipe up\|down [X Y] [fingers] [to P] [hold]` | Moves three fingers together to a chosen progress. |
| `swipe left\|right [X Y] fingers [to P] [hold]` | Moves three fingers horizontally to a chosen progress. |
| `force-click <X> <Y>` | Presses, sends Force Touch pressure stages 1, 2, 1, then releases. |
| `force-click <selector>` | Force-clicks the first matching element. |
| `touch down\|up <ID> <X> <Y>` | Places or lifts a touch-screen finger. |
| `touch move <ID> <X> <Y> [steps N]` | Moves a held finger over interpolated steps. |
| `touch cancel <ID>` | Cancels a held finger. |

Pinch scale must be positive. Pinch and rotation default to eight changed
steps; touch moves default to one. `N` must be a whole number from 1 through
4294967295. Gesture steps are one 120 Hz frame apart, so replies wait for
the gesture playback rather than a separate real-work timeout.

Swipes use the current pointer unless a point is supplied. Horizontal
non-discrete scroll swipes travel 60% of viewport width and become navigation
when nothing scrolls. Finger swipes default to progress 1; `P` must be in
`(0, 1]`. `hold` omits the ending event for a held-gesture capture. `discrete`
cannot combine with `fingers`, `to` or `hold`. Vertical finger swipes accept
an explicit `fingers` word too. Force-click selectors follow the same rules
as click selectors, but take no button or modifier options.

Touch IDs are whole numbers from 0 through 4294967295. The first finger down
is the primary pointer. Reusing a held ID for `down`, or moving, lifting or
canceling an ID that is not down, fails. A long press is a `touch down`,
`wait 600`, then `touch up`.

State: effects depend on the receiving surface (`panes`, `pane_drag`,
`file_blocks`, for example). There are no gesture-progress or touch-ID fields.

## Drag and drop

| Command | Does |
| --- | --- |
| `drop <X> <Y> [file PATH]... [text TEXT] [url URL]... [copy\|move\|link] [hold]` | Sends an incoming system drag at coordinates. |
| `drop <selector> [file PATH]... [text TEXT] [url URL]... [copy\|move\|link] [hold]` | Sends an incoming drag at the first match's center. |
| `drag-end [copy\|move\|link\|none]` | Finishes a drag out of the window. |

A drop must carry at least one file, text or URL. Files and URLs may repeat;
text and operation may occur only once. Payload options, operation and
`hold` may appear in any order. The selector is one argument. The default
operation allows the target to choose; specifying one limits the source to
it. A rejecting target gets no drop and the command fails. The reply reports
`at` and the chosen `op`; `hold` also reports `held: true` and keeps the drag
hovering. The next `drop` moves it on. `drag-end` defaults to `none` (cancel)
and fails unless an outgoing drag is in progress.

State: opened files appear in `file_blocks`; terminal insertion appears in
the receiving terminal. There is no general incoming-drop state field;
`stats` reports an outgoing drag. Based on the `file-drop-split` golden:

```text
size 1280 800
ready
drop 1230 450 file crates/tern/goldens/fixtures/files/sample.rs hold
wait 300
shot file-drop-split-over
drop 1230 450 file crates/tern/goldens/fixtures/files/sample.rs
file wait
shot file-drop-split
```

## Appearance and accessibility preferences

| Command | Does |
| --- | --- |
| `appearance light\|dark` | Changes the simulated system appearance. |
| `reduce-motion on\|off` | Makes animations and transitions jump to their end. |
| `reduce-transparency on\|off` | Changes the session's Reduce Transparency preference. |
| `increase-contrast on\|off` | Changes the session's Increase Contrast preference. |
| `differentiate-without-color on\|off` | Changes the session's Differentiate Without Color preference. |

These affect the session, not global OS settings or saved Tern preferences.
Headless appearance and accessibility changes reach every document; live
input goes to the targeted window. State: `theme` reflects the resolved Tern
appearance. Accessibility preference flags have no dedicated state fields;
inspect the rendered result with `shot` or `dump`.

## Documents, menus and assistive technology

| Command | Does |
| --- | --- |
| `target <name>` | Routes later input and inspection to a named document or live window. |
| `menu <id>` | Chooses an enabled context, menu-bar, Dock or tray action. |
| `menu-close` | Dismisses an open context menu. |
| `a11y click\|focus\|blur\|scroll-into-view\|scroll-up\|scroll-down\|scroll-left\|scroll-right\|show-context-menu\|expand\|collapse\|increment\|decrement <selector>` | Performs a value-free assistive-technology action. |
| `a11y set-scroll-offset <selector> <X,Y>` | Sets a scroll offset. |
| `a11y set-scroll-offset <selector> <X> <Y>` | Sets the same offset with separate numbers. |
| `a11y set-text-selection <selector> <anchor,focus>` | Sets character-index selection endpoints in a field. |
| `a11y set-text-selection <selector> <anchor> <focus>` | Sets the same selection with separate indices. |
| `a11y set-value\|replace-selected-text <selector> <text>` | Sets a field's value or replaces its selected text. |

`main` is the first document. Unknown targets fail and list available names;
a target must already exist. Get menu IDs from `menus`. Unknown or disabled
menu actions fail; choosing a context action closes that menu. `menu-close`
fails if no context menu is open.

The action's selector is one argument. Accessibility actions fail if the
match is not exposed, lacks the requested action or does not perform it.
Value-free actions reject extra values. Pair values accept comma or
whitespace separation, including a quoted pair. Text actions also accept
several unquoted words joined with spaces; `""` clears a value.

State: `focused_element` and the receiving feature's fields reflect action
results. Tern's `menu` field is its own app menu, not a complete native-menu
listing; use `menus` and bare `a11y` for inspection. There is no target field
in Tern's app state.

## Dialogs and system events

| Command | Does |
| --- | --- |
| `dialog [ID] open <PATH>...` | Answers a pending file picker with one or more paths. |
| `dialog [ID] save <PATH>` | Answers a pending save dialog with one path. |
| `dialog [ID] cancel` | Cancels a pending dialog. |
| `dialog [ID] button <N> [checked\|unchecked]` | Chooses a message-box button and optionally its checkbox state. |
| `haptic-reply [ID] submitted` | Acknowledges a pending haptic request. |
| `haptic-reply [ID] unsupported` | Reports that haptics are unsupported. |
| `haptic-reply [ID] failed <message>` | Reports a haptic failure. |
| `notification-click <ID> [action]` | Clicks a posted notification or its action button. |
| `global-shortcut <accelerator>` | Presses a registered global shortcut. |
| `open-files <PATH>...` | Sends the system's request to open files. |
| `open-url <URL>` | Sends the system's request to open a URL. |
| `second-instance [arg...]` | Delivers arguments from a second launch. |
| `power suspend\|resume\|lock\|unlock` | Sends a power or session-change event. |
| `share-finish [service\|cancel]` | Completes or cancels a shown share UI. |

`dialog`, `haptic-reply` and `share-finish` are headless-only. A live window
requires its native dialog, haptic backend or share UI instead. These
commands answer already-pending requests; they do not wait for one to appear.
Without `ID`, dialog and haptic replies answer the oldest pending request.
Get IDs and pending requests from `system`. Dialog button indices start at
zero. An absent request, wrong answer kind, unavailable button or too many
paths for a single-file picker fails. Saving a pending file-save request
writes the file. A haptic `submitted` reply acknowledges submission, not
physical delivery; only `failed` takes a message.

Notification clicks fail for unknown notifications or actions. Global
shortcuts use accelerator syntax such as `CmdOrCtrl+Shift+K` and fail unless
registered. `open-files` requires at least one path. Second-instance events
carry the receiving process's working directory; headless `--open-url` and
`--open-file` arguments also produce their respective open events. Power
changes reach all headless documents. Share completion defaults to `cancel`
and fails when no share UI is shown.

State: system requests and registrations are not `tern ctl state` fields;
use `system` for dialogs, haptics, notifications, shortcuts and sharing.
App effects appear in the appropriate fields, such as `file_blocks` and
`tabs`.

## Web views and spelling

| Command | Does |
| --- | --- |
| `webview <selector> title <text>` | Reports the embedded page's title. |
| `webview <selector> url <URL>` | Reports its displayed address. |
| `webview <selector> loading <P>` | Reports loading progress from 0 through 1. |
| `webview <selector> failed <message>` | Reports a loading failure. |
| `webview <selector> history <true\|false> <true\|false>` | Reports whether back and forward history exist. |
| `webview <selector> focus on\|off` | Reports page keyboard focus. |
| `webview <selector> new-window <URL>` | Reports a page's request for a new window. |
| `spelling [WORD[=GUESS,...]...]` | Marks exactly these words as misspelled, with optional replacement suggestions. |
| `spelling off` | Turns spell checking off. |

Web-view selectors are one argument and must match an element with a web
view. Text, URL and failure payloads are single arguments. These commands
report page events; they do not navigate or wait for a real page. Headless
windows have no pages, so scripts supply their reports this way. Browser
reports have no dedicated `tern ctl state` field; inspect their toolbar with
`tree` or `dump`. File web views affect `file_blocks`. `stats` lists embedded
web views.

Spelling matches words case-insensitively. With no arguments, `spelling`
marks nothing. Headless sessions start with this empty dictionary; live
windows replace their platform spell checker with it. Suggestions appear
in the field's context menu. There is no spelling dictionary state field;
inspect the field or its menu. Based on the `browser-toolbar` golden:

```text
ready
browser open "example.com"
webview ".tn-pane.on .kit-web-page" url "https://example.com/"
webview ".tn-pane.on .kit-web-page" title "Example Domain"
webview ".tn-pane.on .kit-web-page" history true false
webview ".tn-pane.on .kit-web-page" loading 1
browser address
shot browser-toolbar
```

## See also

- [Scripts](index.md): running, quoting, timing and fixtures.
- [Control Commands](control.md): inspection, clocks and system state.
- [Terminal and Panes](terminal.md): shell commands and prompt waits.
- [File Blocks](file.md): file editing and file readiness.
- [Browser Blocks](browser.md): opening and controlling browser blocks.
- [Debugging](../guides/debugging.md#driving-a-window-from-a-script).
