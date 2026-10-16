# Pictures in Picture

`pip` commands create and arrange blocks floating over an owner block in the
active tab. Use them to capture browser cards, focused and expanded views,
stacked decks, or the landing of a drag without relying on pointer coordinates.

## Creating and placing cards

| Command | Does |
| --- | --- |
| `pip float [<corner>]` | Floats the focused split block over the block taking over its space. |
| `pip new [<corner>] ["<address>"]` | Creates a browser card over the focused block. Omitting the address opens a blank browser. |
| `pip corner [#<n>] <corner>` | Moves a card to another corner of its owner. |

Corners are `tl`, `tr`, `bl` and `br`. Long names such as `top-left`,
`top_left`, `topleft` and `"top left"` also work, without regard to case.
`float` defaults to the owner's corner nearest the block's old center;
`new` defaults to bottom right. A browser address can be a URL or a bare host
such as `example.com`; all words after the optional corner form the address.

`float` fails if the focused block cannot float: it needs another eligible
block to own it. Creating a browser card needs a block to float over.

Commands with `[#<n>]` select the card's one-based position in the active tab's
list: `#1` is the oldest. Quote it in scripts (`"#1"`) so it is not treated as
a comment. Without a number, commands choose the focused card, otherwise the
most recently raised card. An out-of-range number, including `#0`, fails with
`no picture in picture to act on`. Bare numbers are not card selectors.

`tern ctl state` exposes the active tab's cards in `pips`: `id`, `owner`,
`corner`, `slot` and `rect` describe their placement.

## Focus, size and docking

| Command | Does |
| --- | --- |
| `pip focus [#<n>]` | Focuses a card, growing and flattening it for interaction. |
| `pip expand` | Toggles the focused card between its normal focused size and filling its frame. |
| `pip resize [#<n>] <w> <h>` | Sets the card's glance or focused size, depending on its current mode. |
| `pip dock [left\|right\|up\|down]` | Returns the focused card to a split beside its owner; if no card is focused, selects the default card first. |

Sizes are integer CSS pixels. Negative widths and heights are converted to
their absolute values; the displayed card is constrained to its frame.
Glance and focused sizes are stored separately. `expand` does nothing unless
a card is focused. Without a direction, `dock` restores the original split
position when available, otherwise uses the side facing the card's corner.
Docking removes the card from `pips`.

State fields `mode`, `size`, `focus_size`, `rect` and `stage_frame` describe
size and presentation. `mode` is `glance`, `focus`, `expanded` or `hidden`.

## Moving and releasing

| Command | Does |
| --- | --- |
| `pip fling [#<n>] <vx> <vy>` | Lifts a card from rest and releases it at the given velocity. |
| `pip drag [#<n>] <dx> <dy> [steps <k>]` | Moves a lifted card by an offset, leaving it held. |
| `pip release [<vx> <vy>]` | Releases the held card, using the drag's sampled velocity unless both components are supplied. |

Offsets are integer CSS pixels and velocities are integer CSS pixels per
second. Positive x points right; positive y points down. A drag defaults to
8 steps. Negative step counts become positive, and zero becomes 1. Use
`pip release 0 0` to land without momentum. A landing can change the corner,
rebind the card to another owner, dock it or stash it at an edge.

`drag` and `fling` fail if the selected card is not shown. `release` fails
with `no picture in picture is held` unless a drag is active. Landing updates
`pips.owner`, `corner`, `stashed` and `flying`; `pip_commits` counts committed
landing gestures. There is no held-drag field in `pips`.

## Stashing, decks and inspection

| Command | Does |
| --- | --- |
| `pip stash [#<n>] left\|right` | Hides a card against the specified edge, leaving a tab to bring it back. |
| `pip unstash [#<n>]` | Brings a stashed card back. |
| `pip stash-all` | Toggles all cards in the active tab between stashed and visible. |
| `pip fan [#<n>]` | Fans out the selected card's corner deck, keeping the pointer logically over it. |
| `pip see [#<n>]` | Makes a glance card translucent and click-through, as if Option were held over it. |
| `pip menu [#<n>]` | Opens the card's context menu near its top edge. |

`see` only affects a glance card. Moving the pointer away or releasing Option
clears the see-through effect. `stash-all` does not require a selected card.
The other commands fail if there is no card to select.

State fields `stashed`, `tab`, `crowded`, `deck`, `slot` and `rect` expose
stashed tabs and deck layout. `deck` is `whole`, `peek<n>` or `hidden` when
laid out. See-through and open menus have no dedicated `pips` field; inspect
the rendered tree or use the control endpoint's `menus` command.

## Timing and parsing

These commands work in headless scenarios and controlled windows; none is
restricted to headless runs. They settle for 650 ms of animation time,
except `drag`, which settles for 50 ms and leaves the card held. They do not
wait for a browser page to load and have no separate real-time timeout. Use
`webview` reports when a capture needs a particular page title or URL.

Missing required numbers, invalid required corners or stash sides, and
unknown subcommands produce usage errors. Numbers must fit a signed 32-bit
integer. Optional invalid corners on `float`, or directions on `dock`, use
the default rather than failing. An unrecognized first word on `new` is part
of the address. The parser ignores extra words after most commands; keep to
the forms above. A leading `#<n>` is consumed after any subcommand, but only
the forms listing it actually use it.

## Examples

Focus and expand a browser card, as in the `pip-focus` scenario:

```text
ready
run "git log --oneline -30 --color=always"
split right
run "ls -G"
pip new br "example.com"
webview ".tn-pane.pip .kit-web-page" title "Example Domain"
focus left
wait 500
pip focus
wait 700
shot pip-focus
pip expand
wait 700
shot pip-expanded
```

Rebind a card by dragging it over another pane, as in `pip-rebind`:

```text
ready
run "ls -G"
split right
run "git log --oneline -12 --color=always"
split down
focus left
pip new br "example.com"
focus left
pip drag 640 -380 steps 12
wait 60
pip release 0 0
wait 700
shot pip-rebind
```

## See also

- [Browser Blocks](browser.md): navigate and inspect browser cards.
- [Terminal and Panes](terminal.md): split and focus owner panes.
- [Harness Commands](harness.md): browser reports and animation captures.
- [Control Commands](control.md): inspect state and menus.
- [Debugging](../guides/debugging.md#driving-a-window-from-a-script): drive a
  running window.
