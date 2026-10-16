# Getting Started

This page takes you from an empty folder to a working plugin with both
halves: a host-side lens that turns `seq` output into a summary and a
sparkline, and a window-side palette command that shows a toast. Along the
way it sets up type checking, reloading and the places errors show up.

You need Tern with its shell integration active in your panes (the default)
and, for type checking, [luau-lsp](https://github.com/JohnnyMorganz/luau-lsp).

## Create the package

A plugin is a folder holding a `plugin.toml` and the Luau files it names.
Make one anywhere; it doesn't have to live in Tern's plugins folder:

```sh
mkdir -p ~/src/first
cd ~/src/first
```

`plugin.toml` declares the plugin and everything Tern must know before any
Lua runs: its id, its two entry files, and the lens with the command lines
it claims.

```toml
schema = 1
id = "first"
name = "First"
version = "0.1.0"
description = "A seq lens and a hello command."
host = "host.luau"
window = "window.luau"

[[lenses]]
id = "seq"
match = ["seq *"]
```

`id` is lowercase letters, digits and `-`, starting with a letter, at most 32
characters. `match` is a list of globs over the command's program and
arguments; `seq *` matches `seq 12` and `seq 1 2 10` but not a bare `seq`.
[Packages and Manifests](../concepts/packages.md) has every key.

`host.luau` is the host half. It runs where your panes run (normally Tern's
session daemon) and implements the lens:

```lua
--!strict
-- The host half: a lens that reads `seq` output as numbers.

type State = { values: { number } }

local ui = tern.ui

local seq: LensDef<State> = {
	open = function(_run, _cx)
		return { values = {} }
	end,
	line = function(state, l)
		local n = tonumber(l.text)
		if n then
			table.insert(state.values, n)
		end
	end,
	finish = function(_state, _status) end,
	view = function(state)
		if #state.values == 0 then
			return nil -- not numbers: keep the raw output
		end
		local sum = 0
		local series: { { any } } = {}
		for i, n in state.values do
			sum += n
			series[i] = { tostring(i), n }
		end
		return ui.col({
			ui.text({
				ui.span(tostring(#state.values), "strong num"),
				ui.span(" numbers, sum "),
				ui.span(tostring(sum), "num"),
			}),
			ui.spark(series),
		})
	end,
}

tern.lens.define("seq", seq)
```

`window.luau` is the window half. It runs in every Tern window on the
machine and adds a palette command:

```lua
--!strict
-- The window half: a palette command.

tern.command({
	id = "hello",
	title = "Say hello",
	icon = "sparkle",
	run = function(cx)
		local how = if tern.runtime.jit then "native code" else "the interpreter"
		cx:toast("info", "Hello from " .. tern.plugin.name, "running on " .. how)
	end,
})
```

The API is the global `tern`. `require("tern")` returns the same table at
run time, but luau-lsp reports it as an unknown require, so these samples use
the global. Which members exist in which half is in
[API Reference](../reference/api.md#contexts); the split itself is explained
in [Architecture](../concepts/architecture.md).

## Link it

`tern plugin link` registers the folder where it is, so you edit in place:

```sh
tern plugin link ~/src/first
```

```text
linked first 0.1.0 → /Users/you/src/first
```

Linking writes `first.path` into the plugins folder (`tern plugin dir`
prints it). With Tern's daemon running, the daemon reloads its plugins and
the command then prints any plugin that failed to load and any folder
problem. Without a daemon it prints `no daemon running; changes apply at
next start`.

`tern plugin list` shows what loaded:

```text
first 0.1.0 First — 0 blocks, 1 lenses, window  ready
```

When no daemon runs, `list` reads the folder without running any Lua, so
`ready` there only means the manifest parsed.

## Set up type checking

`tern plugin types` writes the API's type definitions into the folder:

```sh
tern plugin types ~/src/first
```

```text
wrote /Users/you/src/first/tern.d.luau
```

Point luau-lsp at that file as a definitions file. In VS Code, put this in
the workspace's `.vscode/settings.json`:

```json
{
	"luau-lsp.platform.type": "standard",
	"luau-lsp.sourcemap.enabled": false,
	"luau-lsp.types.definitionFiles": { "@tern": "tern.d.luau" }
}
```

`definitionFiles` maps a name to a path. `platform.type = "standard"` turns
off Roblox's globals, and the sourcemap setting stops luau-lsp from looking
for a Rojo project. No `.luaurc` is needed. From a shell, the same check is:

```sh
luau-lsp analyze --platform=standard --definitions=@tern=tern.d.luau host.luau window.luau
```

Annotate definitions with `LensDef<State>` and `BlockDef<State>` to type the
state your handlers share, and start files with `--!strict` to get the full
checks. Regenerate `tern.d.luau` after upgrading Tern.

## Reload

Tern watches the plugins folder and every linked folder. Saving a file
reloads the plugin's halves within about 300 ms, so most of the time you
just save. To reload by hand:

- `tern plugin reload` reloads the daemon's plugins, prints the same lines as
  `list`, and exits 1 when a plugin failed or a folder has problems. The
  windows on the machine reload their halves when the daemon sends them the
  new catalog.
- **Reload plugins** in the command palette, or **Reload** in
  Preferences › Plugins, has every host the window is attached to (your
  daemon and any remote ones) reload, then reloads the window's own halves.

What a reload keeps and restarts is in
[Lifecycle and Reload](../concepts/lifecycle.md).

## See it work

In any Tern pane, run:

```sh
seq 12
```

The output becomes a block reading "12 numbers, sum 78" over a sparkline.
The block's **Raw** toggle shows the original output, which Tern always
keeps. Run `seq 3 x`: `seq` prints an error instead of numbers, `view`
returns `nil`, and the block shows the raw output.

The lens only sees command lines the shell integration reports, and only
simple ones: `seq 12 | tail -3` or `clear; seq 12` stay ordinary terminal
output. [Command Lenses](lenses.md) explains the rules.

Open the command palette and type "Say hello". The row sits in the group
named after the plugin; choosing it shows a toast "Hello from First" with
"running on native code" (or "the interpreter") beneath.

## When something goes wrong

| What failed | Where it shows |
| --- | --- |
| `plugin.toml` doesn't parse or breaks a rule | `tern plugin list`: `problem DIR: <error>` (for example ``unknown field `bogus`, expected one of …``); the plugin doesn't load |
| An entry raises while loading | `tern plugin list`: `failed: <first line>`, such as `failed: runtime error: …/host.luau:2: attempt to index nil with 'y'`; the full traceback is in the log |
| Either of the above, after a reload | A toast in the windows: "1 plugin has problems" |
| The window half fails to load | A toast "Plugin First failed to load" with the error beneath |
| A handler raises or runs over budget | A toast "Plugin First: seq.view failed" (the hook name varies) with the error's first line, and a log line `plugin handler failed` |

A failing handler loses only that call; the plugin keeps running. A handler
over its budget stays disabled until the next reload.

`print` and `tern.log` write to Tern's log under the target `tern::plugin`,
which the default log filter drops. Start Tern (or the daemon) with
`STENCIL_LOG=warn,stencil=info,tern::plugin=debug` to see them.
[Debugging](debugging.md) covers logs, budgets and the usual mistakes.

## Next steps

- [Command Lenses](lenses.md): claims, line shapes, live views and
  rehydration.
- [Blocks](blocks.md): panes whose program is your Lua.
- [Building Views](views.md): the node model, builders, actions and styling.
- [Host Hooks and the Spawn Filter](hooks.md): reacting to commands and
  shaping new shells.
- [Commands, Keys, and Overrides](commands.md) and
  [Routing Opens and Links](routing.md) for the window half.
- [Distribution](distribution.md) when the plugin is ready for others.
