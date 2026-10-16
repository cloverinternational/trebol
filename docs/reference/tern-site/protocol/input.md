# Input and Events

Keys reach the program as they always have: on the pty, as input. What a
pointer does in a surface, and what changes in the pane, comes back as events.

## Keys

Keys reach the program as pty input: the kitty keyboard protocol, bracketed
paste. A focused `editor` or `input` (the `focus` op) shows Tern's caret, but
the text model is yours: you answer keys with `text` or `splice` ops and a new
`cursor`. IME composition happens in Tern's hidden text area, is drawn as
preedit at the field's caret, and is committed to the pty as typed text.

The exceptions are native editing below: keys acting on Tern's selection
become an `edit` event, and the undo key an `undo` event.

## Native editing

With the `edit` program feature in your `hello`, Tern keeps a selection of its
own in your `editor` and `input` fields, as a GUI text field has, unless the
field has a `mode` (a Vim mode) or is `readonly`. The user can turn it off
(Settings › Terminal › Native composer editing). For a program without `edit`
every key stays the program's, since a key acting on Tern's selection would
reach it as an event it drops.

- ⇧ with the arrows (⇧⌥ or ⇧⌃ ←/→ for words, ⇧⌘ ←/→ or ⇧Home/End for the
  line, ⇧⌘ ↑/↓ for the text), or a drag, double or triple click select; ⌘A
  selects all. On PC keyboards Ctrl stands for ⌘ as their text fields have
  it (Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+⇧←/→, Ctrl+⇧Home/End); Alt and
  Windows/Super chords stay yours and the app's.
- Tern draws its selection instead of your `cursor` and `anchor` until the
  text changes. With a selection, typing, pasting, IME commits, ⌫, ⌦ (with
  their word and line variants) and ⌘X or ⌃X replace it, ⌘C copies it
  locally, and a plain arrow collapses it. Without one, only the selecting
  keys and the drawn-line moves below are Tern's: ⌘C, ⌘X, ⌃X and deletes
  stay yours. An empty field has nothing to select, so every key there stays
  yours (undo aside).
- A click in the focused field places the caret: an `edit` event with
  `from == to`, sent only when the caret moved. A click in a field without
  the focus sends `focus` instead ([Events](#events)).
- Only Tern knows where text soft-wraps, so a plain ↑ or ↓ moves the caret to
  the drawn line above or below (at the x a run of them started from), and
  ⌘← or ⌘→ (Home, End) to the drawn line's start or end. Each of these goes to
  you as one `edit` event, never as keys.
- Otherwise every key is yours as before: ↑ on the first drawn line and ↓ on
  the last (your history), ↑ and ↓ while an `overlay` anchored at the caret
  is open (its list). On PC keyboards, without a selection, Ctrl+Home/End
  (the text's start or end) and Ctrl+Backspace/Delete stay yours too.
- Over a misspelling decorated `typo`, the context menu leads with the
  platform spell checker's guesses; a pick sends an `edit`.

**Undo.** With the `undo` feature too, ⌘Z or ⌃Z (Ctrl+Z on PC keyboards) in a
natively edited field goes to you as one `undo` event instead of a key, with
or without a selection and in an empty field, so a cleared draft can come
back. The history is yours, each `edit` event one step. In Vim mode, with
native editing off, or without `undo`, ⌃Z stays your key.

**Sending.** With the `send` feature, Tern can submit a prompt into your
composer atomically (an initial prompt for an agent, Carly asking it): a
`send` event, not a paste followed by Enter. A field accepts it only while it
reports `sendable:true` (and is not `readonly`, `disabled` or `hidden`),
meaning its owner, its submission handler and what that depends on are
ready. Writable text and focus are separate: a focused,
editable field can still be `sendable:false` while the program starts. Send a
frame setting `sendable:true` when ready, even if nothing else changed; Tern
holds its prompts until then.

## Pointer actions

The common `actions` prop says what a pointer does on a node. It is an
object with an action per gesture, `{"click": act, "dblclick": act, "menu":
[act…]}`, every key optional:

```json
{"id": "row", "k": "text", "p": {"text": "build.log",
  "actions": {"click": "open-log", "dblclick": "copy", "menu": ["rerun", "sort=name"]}}}
```

| Action | Where it runs | Event |
| --- | --- | --- |
| `toggle` | Tern folds or unfolds the node (a collapsible `card`, `section`, `tool`, `agent`, `checklist`) at once | `{"ev":"toggle","id","collapsed","key?"}` |
| `copy` | Tern copies the node's text (Markdown source for `md`, raw text for `code`, `ansi` and `text`, a `block`'s raw output, the `href` when it has one), flashes the node and shows Copied | none |
| `open` | Tern opens the node's `href` or `path` | none |
| `zoom` | Tern shows the `image` large in its viewer, stepping through the images beside it | none |
| `select` | The program | `{"ev":"select","id","item","values?"}` |
| `activate` | The program | `{"ev":"activate","id","item","values?"}` |
| any other name | The program | `{"ev":"action","id","act","value?","mods?","values?"}` |

- `click` and `dblclick` give the node `.sf-act`. A click that opens a link
  (⌘-click, or a plain click on an inline link when Settings › General ›
  Links opens them on a plain click) opens it instead of running `click`.
- `menu` lists context-menu entries, labeled from the action name
  (`open-file` reads Open file), with Tern's Copy appended unless the list
  names `copy`. A pick runs the action as a click does, without `mods`.
- `toggle`'s `key` is still the bare node `key` prop, when it has one; the
  event does not qualify it with the parent. Tern remembers the local fold
  by that key among the node's siblings, not surface-wide. A `del` followed
  by an `add` with a new node id and the same key under the same parent
  preserves the fold; the same key under another parent has independent
  state. Without a key, local state uses the node's id.
- For `select` and `activate` on an `item` of a `list`, `id` is the list and
  `item` the item; on any other node both are the node's id.
- A custom name with `=` splits into `act` and `value` (`"sort=name"`).
  `mods` lists the modifiers held, in the order `shift`, `ctrl`, `alt`,
  `meta` (⌘ is `meta`), and is absent when none is.
- `values` is there when the node sits in an `el` `form`
  ([Form values](#form-values)).

Hover, scrolling, text selection, tooltips and the context menu are Tern's
own. Some kinds send events of their own without an `actions` prop:

| Kind | Events |
| --- | --- |
| `list` items | `select` on click, `activate` on double click, `id` the list ([Lists](../elements/lists.md#item)); an item's own `click` or `dblclick` action replaces the matching one |
| `tabs` | `select` with `item` the tab's id ([Tabs](../elements/lists.md#tabs)) |
| `tree` | `toggle` with `key` the item ([Data](../elements/data.md#tree)) |
| `picker` | `select`, `activate` and `action` ([Picker events](../elements/lists.md#events)) |
| `prefs` | `select`, `activate`, `action`, `focus`, and `change` with `item` and `value` ([prefs](../elements/work.md#prefs)) |
| `checklist` (hud) | `activate` with `item` `"hud"` when its pill opens or closes ([checklist](../elements/work.md#checklist)) |
| `el` checkbox, radio | `change` ([HTML Elements](../elements/el.md#the-change-event)) |
| `editor`, `input` | `focus`, `edit`, `undo` (above) |

## Events

Every terminal → program message is an `e` event, `ESC _ tsp;e;{…} ESC \`
(OSC 877 through a Windows ConPTY, see [Transport](transport.md#windows)). An
event about one surface carries its id as `sf`: every event below but
`theme`, `motion`, and a `gone` answering an `adopt`; an `error` has it when
the rejected message named a surface.

| Event | Payload | When |
| --- | --- | --- |
| `ack` | `s` | The highest frame applied *and drawn*; at most one per displayed frame ([Flow control](operations.md#flow-control)). |
| `resize` | `cols`, `cell` (`{"w","h"}`), `visible` | The pane's live surface was first drawn, or the pane's width in columns or its cell size changed. Only needed for `rows` and ANSI-width decisions. |
| `theme` | `dark` | The appearance switched. |
| `motion` | `reduce` | Reduce Motion was toggled. |
| `visible` | `visible` | The pane was hidden (another tab) or shown again: pause expensive work. |
| `toggle`, `select`, `activate`, `action` | above | A user action. |
| `change` | `id`, `value`, `checked`, `name?`, `values?`; from `prefs`: `id`, `item`, `value` | The user flipped an `el` checkbox or radio ([HTML Elements](../elements/el.md#the-change-event)), or changed a `prefs` row's value. |
| `focus` | `id` | A click asked for the keys: in an `editor` or `input` (not `readonly`) that isn't the focus, or in a `prefs` node while the focus is in a field outside it. Move your focus there (and answer with a `focus` op), or ignore it: a modal overlay keeps the keys. |
| `edit` | `id`, `from`, `to`, `text`, `cursor`, `len` | Native editing: replace UTF-16 `[from, to)` of field `id`'s text with `text` (one undo step), then put the caret at `cursor`. `from == to` with empty `text` only moves the caret. `len` is the length of the text Tern saw: ignore the event when your text has changed since (keys in flight). Only with the `edit` feature. |
| `undo` | `id` | Undo the last change to field `id` through your own history; nothing when there is none. Written in order with the keys around it. Only with the `undo` feature. |
| `send` | `id`, `text` | Submit `text` through composer `id`'s normal submission path, keeping multi-line text, commands and attachments. Only to a live, editable field reporting `sendable:true` of a program with the `send` feature; anything else is dropped. |
| `error` | `s`, `op`, `msg`; or `msg` (with `s` when known); or `sheet`, `msg`; or `id`, `msg` | A rejected op in frame `s` (`op` its index); a rejected message or a dropped chunk; from the view, a stylesheet's parse errors (`sheet`, the messages joined with `; `) or an `el` with an unknown tag (`id`). |
| `gone` | `ids` | Tern dropped these nodes under its retention budget; dropped a surface whose anchor line left (scrolled out of the scrollback, the scrollback cleared, the alternate screen left), `ids` its own id; or an `adopt` found nothing. Stop referencing them. |

## Form values

An `action`, `select`, `activate` or `change` event whose node sits inside an
`el` `form` carries `values`: each enabled, named control of that form as it
is at that moment. A radio group gives its checked radio's `value` (`null`
when none is), a lone checkbox `true` or `false`, and checkboxes sharing a
name the array of the checked ones' values in document order. The click that
submits a form carries what was picked, so you never have to ask:

```json
{"ev":"action","sf":"pick","id":"go","act":"submit","values":{"size":"l","notify":true,"tags":["a","c"]}}
```

The algorithm, with a worked example, is in
[HTML Elements](../elements/el.md#form-values).

## Only to a listening program

Whatever the terminal writes to the pty is typed text to a shell, so Tern
sends only what a program reads:

- Events Tern originates (`ack`, `resize`, `visible`, `theme`, `motion`,
  pointer and view events) go out only while some surface of the pane is open,
  and an event that names a surface only while that surface is open.
- A surface opened with `listen:false` never hears anything: no acks, events
  or errors about it, and after its `o` no answers at all until your next `q`
  or listening `o`.
- Answers to what you sent (replies to `q`, `error`, `gone`) go out unless the
  program is known to be gone: after a shell prompt, the pane's process
  exiting, or RIS, until something asks (`q`) or opens a surface (`o`). A late
  `f`, or the `x` of a surface the prompt already discarded, gets no answer. A
  program that closed its own surfaces with `x` still hears about its
  mistakes, because it may still be reading ([Leaving](surfaces.md#open-and-close)).
