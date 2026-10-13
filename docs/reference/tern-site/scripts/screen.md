# Screen Blocks

`screen` opens a view of a host's display and drives its display selection,
size mode and host input. Use it to capture screen-sharing layouts or exercise
remote input without finding controls in the toolbar.

## Opening and display modes

| Command | Does |
| --- | --- |
| `screen open` | Opens a screen block beside the focused pane and focuses it; with no tab open, creates a tab of its own. |
| `screen display <id>\|main` | Shares the named display, or the host's main display. |
| `screen fit` | Fits the display inside the block, scaling down but never up. |
| `screen actual` | Shows one frame pixel per device pixel, with scrolling. |
| `screen control on\|off` | Enables host input or makes the block view-only. |

A new block shares the current host's main display, fitted, with control on.
Every command except `open` requires a focused screen block; otherwise it
fails with `no screen block has focus`. Display IDs come from
`tern ctl state` → `screen_blocks[].displays`. `main` selects the default
rather than a literal display ID. Display selection and modes are shared
between windows viewing the same block.

`open` waits for the first frame to have been shown for 250 ms of real time,
or for sharing to fail, then settles for 300 ms of app time. `display`,
`fit` and `actual` wait for the host's next frame using the input wait rules
below. `control` only settles for 300 ms of app time; it does not wait for a
frame or permission approval.

In `screen_blocks`, `chosen` records the requested display (`null` for
`main`); `display` and `display_name` describe the actual display. `actual`
and `control` record the selected modes. `frame` and `fit` report frame and
fit sizes, and `frames` counts frames shown.

## Host input and waits

| Command | Does |
| --- | --- |
| `screen click <x> <y>` | Sends a primary-button click at floating-point coordinates in the display's own pixels. |
| `screen key <name>` | Presses and releases one supported key, without modifiers. |
| `screen type ["<text>"]` | Sends text as an input-method commit; omitted text sends an empty string. |
| `screen wait` | Waits for the host to draw the last input sent. |

Key names are lowercase `a`–`z`, `0`–`9`, `enter`, `escape`, `backspace`,
`tab`, `space`, `left`, `right`, `up` and `down`. Other names fail to parse;
there are no modifier chords in `screen key`. Coordinates are display
pixels, not window coordinates, and do not change meaning in Fit mode.
`type` consumes the remaining words as text; quote text containing spaces.
The other commands consume their required arguments and ignore extra words.
Missing display IDs, invalid control values and nonnumeric or missing click
coordinates fail to parse.

`click`, `key` and `type` require a live sharing connection with control on;
otherwise they fail with `the screen block isn't sharing with control`.
These commands and `wait` wait until a frame arrived after the last input
and no new frame has been shown for 250 ms of real time. If the host draws
nothing, they finish after two seconds of real time. A sharing failure also
ends the wait. With no input pending, `wait` uses the first-frame rule.
Each frame wait is followed by 300 ms of app-time settling; the harness's
20-second timeout still applies. A completed wait does not prove that
capture or input succeeded: inspect `screen_blocks[].failure` and
`input_refused`. `connected` reports a live connection, and `cursor` reports
whether the host has supplied a cursor shape.

## Headless runs and host permissions

Headless runs use a synthetic test pattern rather than capturing or driving
the real desktop. It includes editor, scroller and photo windows and marks
input for screenshots. To use it outside headless runs, set
`STENCIL_SCREEN_SOURCE=synthetic` in the screen host's environment. For a
local daemon, this must be the environment in which the daemon starts, not
just the environment of an already-connected window.

Real screen hosting is supported on macOS, Windows and Linux; iOS and web
viewers can view a remote host's screen but cannot host their own. macOS
requires Screen Recording permission for capture and Accessibility permission
for input for the daemon's app. Wayland asks through the desktop portal for
each session; the portal chooses the display and permits remote control.
X11 asks no permission. Windows cannot inject input into higher-integrity
windows, such as an elevated program. Capture failures appear in `failure`;
input refusals appear in `input_refused` even when control is enabled.

This follows the screen-input golden: click the synthetic editor, type into
the shared canvas and send a text commit before capturing it.

```text
ready
screen open
screen click 300 200
click .sc-canvas
type hello
screen type "!"
screen wait
shot screen-input
```

## See also

- [Scripts](index.md): syntax, running scripts and timing.
- [Remote Hosts](remote.md): connecting to the host whose screen is shared.
- [Harness Commands](harness.md): window input and screenshots.
- [Control Commands](control.md): inspecting `state`.
- [Debugging](../guides/debugging.md): driving a running window.
