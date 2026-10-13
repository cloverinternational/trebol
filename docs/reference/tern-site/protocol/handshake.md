# Handshake

A program finds out whether its terminal speaks TSP, and what it supports,
with one query.

## Detection

Write the `hello` query followed by a DA1 request (`ESC [ c`), which every
terminal answers:

```text
ESC _ tsp;q;{"q":"hello","v":[1],"app":"omp","ver":"14.2.0","features":["edit","undo","send"]} ESC \  ESC [ c
```

A terminal that speaks TSP answers the query before the DA1 reply, on your
input like any terminal report. A DA1 reply with no `tsp;r` before it means
no TSP: keep your own renderer.

| Field | Meaning |
| --- | --- |
| `v` | The protocol versions you speak. Tern speaks only `1`: a query whose list lacks it gets no reply at all, so it reads as no TSP. |
| `app` | Your program's name. While one of your surfaces is open and listening, Tern shows that program as the pane's (its icon on the tab and in the palette), even in a window that attached after the command started. |
| `ver` | Your program's version. Tern doesn't use it. |
| `features` | What you handle beyond v1 (below). Unknown names are ignored. |

Each `hello` replaces what the last one said: a later `hello` without
`app` or `features` clears them. Tern forgets both once your program is
gone (the shell's next prompt, the pane's process exiting, a terminal
reset), and applies them only while one of your surfaces is open and
listening.

Program features:

| Feature | Means |
| --- | --- |
| `edit` | You apply `edit` events, so Tern may keep a native selection in your editors ([Native editing](input.md#native-editing)). |
| `undo` | You apply `undo` events, so Tern may take the undo key in them. |
| `send` | You submit text supplied in a `send` event through a composer's normal submission path. This is a capability, not readiness: the target field must also report `sendable:true`. |

A snapshot replays the hello first, so the `app` name and features survive a
window restart.

## Reply

```json
{"r":"hello","v":1,"term":"tern","ver":"0.4.3",
 "kinds":["col","row","card","section","rule","spacer","text","md","code","diff","ansi","math",
  "image","kv","table","tree","badge","kbd","icon","spinner","shimmer","elapsed","progress","rate",
  "list","item","tabs","editor","input","status","seg","overlay","toast","rows","picker","prefs",
  "tool","checklist","agent","chart","meter","block","effort","el"],
 "features":["blobs","settle","adopt","dock","program-palette","reduce-motion","aside","scroll","styles","flow"],
 "apc":65536,"credits":2,
 "cols":120,"cell":{"w":8,"h":17},"dark":true,"reduceMotion":false,"hour12":false}
```

| Field | Meaning |
| --- | --- |
| `v` | The version the terminal picked from your list (`1`). |
| `term`, `ver` | The terminal and its version: `tern` and the same version as `TERM_PROGRAM_VERSION`. |
| `kinds` | Every node kind it draws ([Elements](../elements/index.md)). Fall back per kind: a kind not listed can be described another way, or as pre-rendered `rows`. |
| `features` | Behavior a kind alone doesn't imply (below). |
| `apc` | The largest body to send in one message (65536 bytes); [chunk](transport.md#chunking) larger ones. |
| `credits` | How many frames you may have unacknowledged (2; [Flow control](operations.md#flow-control)). |
| `cols`, `cell` | The pane's width in columns and its cell size in pixels. You only need them for `rows` fallback and ANSI-width decisions; `resize` events update them. |
| `dark` | Whether the terminal shows its dark appearance (`theme` events update it). |
| `reduceMotion` | Whether Reduce Motion is on (`motion` events update it). You may drop motion-only nodes then. |
| `hour12` | Whether the user's system reads a 12-hour clock (`3:05 PM`) rather than 24-hour (`15:05`): the window's regional settings (macOS's 24-Hour Time, Windows' short time format, GNOME's or Cinnamon's clock format, else `LC_TIME`, on Linux), even when your program runs on another machine. Format the times you show with it (`hour12` in JavaScript's `toLocaleTimeString`); your own process's locale may not know. |

Terminal features:

| Feature | Means |
| --- | --- |
| `blobs` | The `b` verb and the `blobs` query. |
| `settle` | The `settle` op is a useful hint ([Frame ops](documents.md#frame-ops)). |
| `adopt` | `o` with `adopt:true` reopens a closed surface ([Surfaces](surfaces.md#open-and-close)). |
| `dock` | The `dock` region sticks to the pane's bottom ([Regions](surfaces.md#regions)). |
| `program-palette` | The `t` verb colors your surface ([Program palette](theme.md#program-palette)). |
| `reduce-motion` | `reduceMotion` and `motion` events are reported. |
| `aside` | A `prefs` node in an inline surface's `layer` docks beside the pane ([Regions](surfaces.md#regions)). |
| `scroll` | The `scroll` op ([Frame ops](documents.md#frame-ops)). |
| `styles` | The `s` verb ([Stylesheets](theme.md#stylesheets)). |
| `flow` | `mode:"flow"` surfaces ([Modes](surfaces.md#modes)) and `listen:false` ([Open and close](surfaces.md#open-and-close)). |

## Other queries

`blobs` asks which blobs Tern already has, so a restarted program resends
only what's missing:

```text
→ ESC _ tsp;q;{"q":"blobs","ids":["9f86d0…","2c26b4…"]} ESC \
← ESC _ tsp;r;{"r":"blobs","have":["9f86d0…"]} ESC \
```

`ids` are sha256 hex ids as the `b` verb names them. `have` lists the ones
Tern holds, in the order you asked. Asking counts as a use: when Tern
evicts unreferenced blobs, least recently used first, the ones you just
asked about go last.

Tern answers no other query: an unknown `q` gets no reply. A `q` (or any
message) whose body isn't valid JSON gets an `error` event, like
`{"ev":"error","msg":"malformed q body: …"}`.

## Starting without waiting

Waiting for the reply delays the first paint by a round trip. When the
environment names Tern (`TERM_PROGRAM=tern`) and you aren't inside a
multiplexer, you may send `o` and your first `f` at once, on assumed v1
capabilities: every kind, `apc` 65536 and `credits` 2, `cols` from the
terminal size, `reduceMotion` and `hour12` false. Switch the tty to raw input before the
query goes out, so Tern's events aren't echoed by a cooked tty. The reply
still decides when it arrives: its `kinds`, `apc`, `credits` and appearance
replace the assumptions. If DA1 answers without a reply, or none arrives
within a second, close the surface (`x` with `keep:false`) and paint with your
own renderer. omp starts this way.

## Environment and opt-outs

- Tern sets `TERM_PROGRAM=tern` and `TERM_PROGRAM_VERSION` for every pane: in
  a window, in the session daemon and in a daemon reached over `tern remote`.
  The environment doesn't survive ssh; the query does, so the handshake is
  what counts.
- Tern's "Native program surfaces" setting turns TSP off: Tern then never
  answers `hello` and ignores every TSP message.
- tmux, screen and zellij swallow APC strings. Inside one, don't probe.
- Give your users a switch of their own to force your ANSI renderer (omp has
  `PI_TUI_NATIVE=0`).
