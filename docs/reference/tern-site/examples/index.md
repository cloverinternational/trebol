# Example Plugins

Seven complete plugins ship in [the SDK](../index.md#the-sdk) under
[`plugins/examples/`](https://github.com/stencil-hq/tern-sdk/tree/main/plugins/examples).
Each one solves a real problem end to end and is written against the
current API, so it doubles as a reference for how the pieces fit together.
Every page explains the design decisions and then includes the full
source.

## The examples

| Example | What it does | Halves | Surfaces it demonstrates |
| --- | --- | --- | --- |
| [Terraform Plans](terraform.md) (`terraform`) | Shows `terraform plan` and `tofu plan` as summary badges, diagnostics and resources grouped by action; a click copies an address | Host | Command lens with `match` globs, line-by-line parsing, badge tones, collapsible sections, click actions through the lens `event` cx, role-scoped manifest CSS |
| [Review Queue](review-queue.md) (`review-queue`) | Lists the pull requests waiting for your review, polled from `gh` every two minutes | Host, window | Block with keys, events and saved state; `tern.process.run` with timeouts; `tern.timer` polling; error views; a palette command and key bind that open the block with `cx:new_block` |
| [JSON Explorer](jsonx.md) (`jsonx`) | Browses JSON files as a collapsible tree and copies jq paths | Host, window | File-backed block from `files` globs and launch args; `tern.fs.read` behind a size check; list selection and scrolling; saved state; `tern.route.open` with a switch kept in `tern.kv` |
| [Long-Running Commands](longrun.md) (`longrun`) | Toasts slow commands as they finish and keeps their history | Host, window | `command_started`/`command_finished` host hooks, toasts, a history block with a live clock, a status segment, a module shared by both halves |
| [Directory Variables](dirvars.md) (`dirvars`) | Loads `.tern-env` files into each new shell's environment | Host | The `spawn` filter and its time limit, `cwd` hooks that hint when the files change, a parser module |
| [Project Workspaces](workspaces.md) (`workspaces`) | Opens the tabs and splits a project describes in `.tern/workspace.json` | Window | `cx.layout:tab` layouts, `window_start`, a `new_tab` override, a status segment, manifest CSS |
| [Canvas Dashboard](../reference/api-window.md#canvas-cx) (`canvas-demo`) | Keeps a persistent dashboard with a Refresh action | Window | `cx.canvas` ownership, replica reads, keyed patches and owner-only `canvas_action` handlers |

## Which example to read

| You want to… | Start with |
| --- | --- |
| Turn a command's output into a native view | [Terraform Plans](terraform.md) |
| Build an interactive block with keys and saved state | [JSON Explorer](jsonx.md), then [Review Queue](review-queue.md) |
| Show persistent content without a host worker | [Canvas Dashboard](../reference/api-window.md#canvas-cx) |
| Run a program in the background and keep a view fresh | [Review Queue](review-queue.md) |
| Take over how a kind of file opens | [JSON Explorer](jsonx.md) |
| React to commands in every pane | [Long-Running Commands](longrun.md) |
| Change what a new shell starts with | [Directory Variables](dirvars.md) |
| Arrange tabs and panes, or replace a built-in command | [Project Workspaces](workspaces.md) |

## Trying one

Each example is a plugin folder with a `plugin.toml`, its Luau files and a
`README.md`. Install a copy straight from [the SDK](../index.md#the-sdk):

```sh
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/jsonx
```

or clone the SDK and link the folder, so Tern reloads the plugin every time
you save a file in it:

```sh
git clone https://github.com/stencil-hq/tern-sdk
tern plugin link tern-sdk/plugins/examples/jsonx
```

`tern plugin list` shows whether it loaded, and `tern plugin unlink jsonx`
or `tern plugin remove jsonx` takes it out again. Every example starts
with `--!strict` and type-checks against the definitions file that
`tern plugin types DIR` writes; see
[Getting Started](../guides/getting-started.md) for the luau-lsp settings.
