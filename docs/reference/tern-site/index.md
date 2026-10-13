# Tern Plugin SDK

Tern plugins are Luau packages that extend and modify Tern. A plugin can add
block types (native panes drawn from Lua), read shell commands' output as
command lenses, react to pane lifecycle, add palette commands and key binds,
override built-in commands, route file opens and links, format the tab bar,
window title and status line, restyle the app with CSS, and script the window
layout.

A plugin is a folder holding a `plugin.toml` manifest and up to two Luau entry
files. Put it under `<config>/plugins/` (or link it there with
`tern plugin link`) and it changes Tern on that machine.

```toml
schema = 1
id = "hello"
name = "Hello"
version = "0.1.0"
host = "host.luau"
window = "window.luau"
```

## Two halves

Every plugin has up to two halves, each running in its own Luau VM:

| Half | Entry | Runs in | Can do |
| --- | --- | --- | --- |
| **Host** | `host = "host.luau"` | The session daemon, or a window that runs panes without one | Blocks, command lenses, pane hooks, the spawn filter, writing to panes |
| **Window** | `window = "window.luau"` | Each Tern window, on its UI thread | Commands, key binds, overrides, routes, chrome formatters, CSS, layout, window events |

The host half runs where the panes run, so a block it defines is an ordinary
pane: every window attached to the session shows it, and it survives a window
quitting. The window half sees and changes one window. See
[Architecture](concepts/architecture.md).

## Choose a path

- **Read a command's output natively:** a [command lens](guides/lenses.md)
  claims command lines with manifest globs and turns their output into tables,
  trees and badges.
- **Add a pane type:** a [block](guides/blocks.md) keeps state in Lua, renders
  views with [`tern.ui`](guides/views.md) and handles keys and clicks.
- **Change how Tern behaves:** [commands, keys and overrides](guides/commands.md),
  [routing](guides/routing.md), [chrome and styling](guides/chrome.md) and
  [layout](guides/layout.md) run in the window half.
- **React to what shells do:** [host hooks](guides/hooks.md) see commands
  start and finish, directories and titles change, and can rewrite how shells
  spawn.
- **Make any program draw natively:** a CLI, TUI or agent that isn't a
  plugin speaks the [Surface Protocol](protocol/index.md) on its pty and gets
  the same native elements, in a flow among its output or full-screen.
- **Look up a node kind or a style hook:** [Elements](elements/index.md)
  documents every kind a view can hold, and [Styling Views](styles/index.md)
  every class, attribute and variable a sheet can use.
- **Script Tern:** [scripts](scripts/index.md) drive a window or a headless
  run command by command, from opening panes to screenshots.

Start with [Getting Started](guides/getting-started.md), then read the
[example plugins](examples/index.md): each is a complete, realistic plugin.

## The SDK

The SDK is the [stencil-hq/tern-sdk](https://github.com/stencil-hq/tern-sdk)
repository. In it, `plugins/examples/` holds the
[example plugins](examples/index.md), one installable folder each, and
`plugins/tern.d.luau` the definitions they type-check against; the
[Surface Protocol SDKs](protocol/sdks.md) sit beside them.

```sh
git clone https://github.com/stencil-hq/tern-sdk
```

The repository's `tern.d.luau` matches these docs; `tern plugin types DIR`
writes the one your Tern ships.

## Documentation conventions

Code is Luau as Tern runs it: `--!strict` works, and `tern plugin types DIR`
writes the `tern.d.luau` declarations luau-lsp needs. Paths written
`<config>` and `<state>` are Tern's configuration and state directories
([Packages and Manifests](concepts/packages.md#directories)). The
[API Reference](reference/api.md) follows the `tern.d.luau` declarations the
runtime ships; when a guide and the reference disagree, the reference wins.

Every page is also published as Markdown at its own path with `.md` in place
of `.html` (`protocol/surfaces.md`, `index.md`), for agents and other tools
that read text.

Installing a plugin means trusting it, as with Neovim or WezTerm plugins: the
`tern` API can write files and spawn processes. See
[Trust and Security](concepts/security.md).
