# SDKs

Four libraries speak TSP for you, in Rust, Python, Go and TypeScript. They
live in the [stencil-hq/tern-sdk](https://github.com/stencil-hq/tern-sdk)
repository and agree byte for byte on the wire.

| Language | Package | Builders |
| --- | --- | --- |
| Rust | crate `tern-sdk` ([`rust/`](https://github.com/stencil-hq/tern-sdk/tree/main/rust)) | `ui::card().head("…").child(…)`, handlers as your message type |
| Python | `tern-sdk`, `import tern_sdk` ([`python/`](https://github.com/stencil-hq/tern-sdk/tree/main/python)) | `ui.card(…, head="…")`, handlers as callables |
| Go | `github.com/stencil-hq/tern-sdk/go/tern` ([`go/tern/`](https://github.com/stencil-hq/tern-sdk/tree/main/go/tern)) | `ui.Card{Head: ui.T("…")}`, handlers as funcs |
| TypeScript | `@stencil-hq/tern` ([`typescript/`](https://github.com/stencil-hq/tern-sdk/tree/main/typescript)) | TSX: `<card head="…">`, handlers as props |

The same card, kept in the scrollback in Tern and printed as plain text
anywhere else:

```rust
tern_sdk::print(
	ui::card().head("cargo test").status(ui::Status::Done).child(ui::md("All **42** tests pass.")),
	PrintOptions::new(),
)?;
```

```python
tern_sdk.show(ui.card(ui.md("All **42** tests pass."), head="cargo test", status="done"))
```

```go
tern.Print(ctx, tern.Main(ui.Card{
	Head:     ui.T("cargo test"),
	Status:   ui.Done,
	Children: ui.Nodes(ui.Md{Text: "All **42** tests pass."}),
}), tern.PrintOptions{})
```

```tsx
await print(
   <card head="cargo test" status="done">
      <md>{'All **42** tests pass.'}</md>
   </card>
);
```

## What they do for you

| Protocol part | The SDK |
| --- | --- |
| [Transport](transport.md) | Frames every message, chunks bodies at the `apc` limit where Tern's parser reads every piece back whole, and encodes blobs by SHA-256. Its input parser splits `tsp;r` and `tsp;e` (APC or OSC 877) out of the pty input and passes keys through; text inside a bracketed paste is never read as TSP. |
| [Handshake](handshake.md) | Puts the tty in raw mode, sends `hello` with DA1, and reports no TSP on `TERN_TSP=0`, without a tty, inside tmux, screen or zellij, when DA1 answers first or after a second. Keeps `cols`, `dark` and `reduceMotion` current, and exposes `hour12` (false from terminals that don't send it). |
| [Surfaces](surfaces.md) | Opens, styles and closes surfaces; closing sends the last pending frame, then `x`, undoes its terminal modes and drains input so no reply reaches the shell. |
| [Documents and Frames](documents.md) | Renders whole views and sends only the difference, with ids derived from keys exactly as Tern's [plugin worker](../guides/blocks.md#regions-node-ids-and-keys) derives them: `main.<key or index>…`. Text that grows by a suffix goes out as an `append`. |
| [Input and Events](input.md) | Decodes keys (legacy xterm, kitty `CSI u`, paste) and routes each event by its surface and node id to the handler on that node; the rest reach your loop. |
| [Flow control](operations.md#flow-control) | Keeps at most `credits` frames unacknowledged and folds every render made while waiting into one frame. |
| [Debugging](operations.md#debugging) | `TERN_TSP_RECORD=<file>` records every message as JSONL for `surface-play`. |

Two helpers cover most CLIs: `print` (`show` in Python) draws a static view
in a `flow` surface that stays as command output, and `ask` shows a form and
returns the action that submits it with the form's `values`. `plain` renders
any view as plain text for the fallback.

Each SDK ships the same four examples: `table` (a directory listing with
`print`), `ask` (the form from the [session above](index.md#a-whole-session)),
`progress` (a streamed build log in a running card) and `chat` (an inline
surface with a docked editor the program drives from keys).
