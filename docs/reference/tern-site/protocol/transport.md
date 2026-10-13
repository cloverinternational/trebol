# Transport

TSP travels in-band on the pane's pty as APC strings. That works over ssh,
stays ordered with every other byte the program writes, and lets Tern's
session daemon keep and replay surfaces with no second channel.

## Framing

```text
ESC _ tsp ; <verb> [; <key>=<value>]* ; <body> ESC \
```

- `verb` is one letter (below), case-sensitive.
- A segment after the verb is a parameter only when it has the form
  `key=value` (key `[A-Za-z0-9_-]+`, value printable ASCII other than `;`,
  no spaces) *and* another `;` follows it. The first segment that isn't one
  starts the body, so a JSON body with `;` or `=` inside stays whole, and a
  message with no parameters is just `tsp;<verb>;<body>`.
- `body` is UTF-8 JSON, or base64 for `b`. JSON escapes every control
  character, so a body never contains ESC or BEL; Tern treats an 8-bit
  `0x9C` inside the string as payload, not a terminator, so raw UTF-8 is safe.
  A body that isn't valid JSON gets an `error` event,
  `{"ev":"error","msg":"malformed f body: …"}`.
- End every message with the 7-bit ST `ESC \`. Tern's parser also ends any
  string at BEL, as kitty does, but TSP defines only ST: never send
  BEL-terminated TSP.
- Unknown verbs and unknown JSON fields are ignored in both directions (an
  unknown verb gets no `error`). New fields are optional forever; an
  incompatible change bumps the protocol version (see
  [Handshake](handshake.md)).

The parameters Tern reads:

| Parameter | On | Meaning |
| --- | --- | --- |
| `c`, `m` | any verb | [Chunking](#chunking) |
| `id`, `mime` | `b` | The blob's SHA-256 and MIME type ([Blobs](#blobs)) |
| `key`, `buf`, `seeded` | `o` | Reserved for the snapshots Tern's session daemon replays, and read only there: on a program's `o` they are ignored. |

| Verb | Direction | Meaning |
| --- | --- | --- |
| `q` | program → terminal | A query: `hello`, blob presence ([Handshake](handshake.md)) |
| `o` | program → terminal | Open a surface ([Surfaces](surfaces.md)) |
| `f` | program → terminal | A frame: an atomic batch of document ops ([Documents and Frames](documents.md)) |
| `b` | program → terminal | A blob (below) |
| `t` | program → terminal | The program palette ([Palette, Stylesheets and Icons](theme.md#program-palette)) |
| `s` | program → terminal | A stylesheet ([Palette, Stylesheets and Icons](theme.md#stylesheets)) |
| `x` | program → terminal | Close a surface ([Surfaces](surfaces.md)) |
| `r` | terminal → program | The reply to a `q` |
| `e` | terminal → program | An event ([Input and Events](input.md)) |

Terminal → program messages travel on the pty's *input* side, like the
replies to DA or OSC 11, each as one `ESC _ tsp;<verb>;<json> ESC \` string
with no parameters: Tern never chunks them. Read your input with an
escape-sequence buffer that takes whole APC strings of any length (an event
carrying form values can be long) and routes `ESC _ tsp;` strings to your
TSP code before key handling. Never echo or print them.

A frame that appends streamed Markdown and marks a card done:

```text
ESC _ tsp;f;{"sf":"s1","s":812,"ops":[["text","a41","append"," and then the parser"],["set","t9",{"tone":"success","status":"done"}]]} ESC \
```

## Chunking

A body larger than the negotiated `apc` limit (65 536 bytes unless the hello
reply says otherwise) is split across messages with the same verb, each
carrying `c=<chunk-id>` (a token you choose) and, on every chunk except the
last, `m=1`. Tern joins the bodies byte by byte before parsing, so a split
may fall inside a UTF-8 character, but not where the next chunk's body would
start with a parameter-shaped segment (below). The joined message keeps the
first chunk's other parameters (a blob's `id` and `mime`); later chunks' are
ignored:

```text
ESC _ tsp;f;c=k7;m=1;{"sf":"s1","s":9,"ops":[["text","log","append","…first 65 000 bytes… ESC \
ESC _ tsp;f;c=k7;…the rest…"]]} ESC \
```

Tern joins one sequence at a time, so send a message's chunks back to back.
A sequence is dropped with an `error` event
(`{"ev":"error","msg":"chunked f message c=k7 dropped: interrupted"}`) when
any TSP message other than its next chunk arrives (no `c`, another `c`, or
another verb), after 1 s without a chunk (`timed out`), or once the joined
body would pass 24 MiB (`over 25165824 bytes`). RIS drops it silently. A
message that interrupts a sequence is still handled on its own.

Every chunk is parsed for parameters like any message, so a chunk's body
must not itself start with a parameter-shaped segment: a JSON chunk that
begins `x=1;y…` loses `x=1` as a parameter, silently. When a split point
would leave such a prefix, move it: a split right before a `;`, or before
any byte other than `A`–`Z`, `a`–`z`, `0`–`9`, `_` and `-`, is always safe.
Base64 has no `;`, so blob chunks are safe. Tern's own chunker (the
snapshots its session daemon replays) follows the same rule.

Tern's parser abandons an APC string longer than 262 144 bytes (everything
after `ESC _`, parameters included) without an `error`, and the rest of the
string then shows on the screen as text. Tern accepts a single string up to
that size, but keep each chunk within `apc`.

## Blobs

`b` sends binary data, an image an `image` node shows, once:

```text
ESC _ tsp;b;id=<sha256 hex>;mime=image/png;<base64> ESC \
```

- The body is standard base64 (`+/`, `=` padding, no line breaks).
- `id` is the hex SHA-256 of the decoded bytes (64 digits; nodes name the
  blob by its lowercase form). Tern rejects, with an `error` event, a blob
  without a valid `id`, with bad base64, or whose bytes don't match `id`.
  `mime` is optional.
- A blob is at most 16 MiB decoded, and chunks like any message (`id` and
  `mime` on the first chunk).
- Blobs are content-addressed, shared by the pane's surfaces, and kept on
  disk by Tern, so a restored screen shows its images without a resend. Ask
  which you still need to send with the `blobs` query
  ([Handshake](handshake.md#other-queries)).

## Windows

On Windows the pty is a ConPTY, whose host (`OpenConsole.exe` or conhost) sits
between Tern and the program in both directions.

**Terminal → program.** ConPTY's input parser discards APC strings, so
`ESC _ tsp;…` input would never reach the program. It passes OSC strings
through raw, so Tern writes terminal → program messages into a ConPTY as

```text
ESC ] 877 ; tsp ; <verb> [; <key>=<value>]* ; <body> ESC \
```

with the body byte for byte the same except for U+0080–U+009F: the parser
takes C1 controls inside the string and U+009C would end it, so those code
points (only ever inside a JSON string) travel as their JSON escapes
`\u0080`…`\u009f`. Accept both framings, and a BEL-terminated OSC 877, and
treat them alike. OSC 877 is only ever terminal → program; terminals on macOS
and Linux keep APC.

**Program → terminal.** Messages stay APC. The inbox conhost of Windows
re-renders the program's output and drops APC, so TSP needs the ConPTY that
Tern bundles (`conpty.dll` and `OpenConsole.exe`, installed next to
`tern.exe`). That host writes the program's output to the terminal as it is
and leaves queries such as DA1 to the terminal, so the hello and its DA1
sentinel reach Tern in order and are answered in order.
