# Packages and Manifests

A plugin is a directory holding a `plugin.toml` manifest, up to two Luau
entry files, and whatever modules and style sheets they use. This page covers
the package layout, the manifest, where packages and their data live, how
plugin things are named, and how a folder that is not a usable plugin is
reported. The full key-by-key rules are in the
[Manifest Reference](../reference/manifest.md).

## Package layout

```text
k8s/
  plugin.toml      -- the manifest (schema 1)
  host.luau        -- host half: blocks, lenses, pane hooks
  window.luau      -- window half: commands, keys, routes, chrome, layout
  k8s.css          -- global styles, listed in `styles`
  lib/
    pods.luau      -- require("./lib/pods")
```

Only `plugin.toml` and the entries it names are required. Entry and style
paths are relative to the package directory and cannot leave it. Nothing
else in the folder is read unless an entry `require`s it or a handler reads
it with `tern.fs`.

## The manifest

`plugin.toml` uses schema 1. Unknown keys are errors, at the top level and
inside every table, so a typo fails the package instead of being ignored.

```toml
schema = 1
id = "k8s"
name = "Kubernetes"
version = "0.1.0"
description = "Pods as a block, kubectl get as a table."
icon = "box"
host = "host.luau"
window = "window.luau"
styles = ["k8s.css"]

[[blocks]]
id = "pods"
title = "Pods"
files = ["*.yaml"]

[[lenses]]
id = "get"
match = ["kubectl get *", "k get *"]
```

| Key | Purpose |
| --- | --- |
| `schema` | Must be the integer `1`. |
| `id` | The plugin's identity on the machine; prefixes everything it names. |
| `name` | Display name: palette group, toasts, Preferences. |
| `version` | Free-form; shown by `tern plugin list` and Preferences. |
| `description`, `icon` | Optional; an unknown or absent icon becomes `puzzle`. |
| `host`, `window` | The two entries; at least one is required. Each is a relative `.luau` or `.lua` path. |
| `styles` | CSS files concatenated into one global sheet, at most 256 KiB in total. |
| `[[blocks]]` | Block types; each needs `tern.block.define` in the host entry. |
| `[[lenses]]` | Command lenses and the globs that claim commands; each needs `tern.lens.define` in the host entry. |

Blocks and lenses are declared in the manifest and defined in Lua, and the
two must agree. The manifest half is what every replica knows from the
catalog (block titles and icons, lens claims) without running Lua; the Lua
half is what the host runs. Defining an undeclared id raises inside the entry
(`tern.block.define: block "x" is not declared in plugin.toml`); declaring an
id the entry never defines fails the plugin once the entry finishes
(`block x is declared in plugin.toml but not defined with tern.block.define`).
`[[blocks]]` and `[[lenses]]` therefore require a `host` entry.

## Directories

Paths in these pages use two placeholders. `<config>` is Tern's
configuration directory and `<state>` its state directory:

| Platform | `<config>` | `<state>` |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Tern` | `~/Library/Application Support/Tern` |
| Linux | `$XDG_CONFIG_HOME/tern` (`~/.config/tern`) | `$XDG_STATE_HOME/tern` (`~/.local/state/tern`) |
| Windows | `%APPDATA%\Tern` | `%LOCALAPPDATA%\Tern` |
| Any, with `TERN_CONFIG_DIR` set | `$TERN_CONFIG_DIR` | `$TERN_CONFIG_DIR` |

### The plugins folder

Packages live in `<config>/plugins/`; `tern plugin dir` prints it. On iOS
the folder is the app's `Documents/Plugins`, which the Files app shows as
On My iPhone (or iPad) › Tern › Plugins. iOS has no command line or `git`:
copy a package folder there.

Tern reads the plugins folder's entries in name order:

| Entry | Treated as |
| --- | --- |
| A directory (or a symlink to one) | A package; its `plugin.toml` must be directly inside. |
| A file `<name>.path` | A linked package: the file's trimmed content must be an absolute path to a package directory. `tern plugin link DIR` writes `<id>.path`. |
| A name starting with `.` | Skipped. `tern plugin` stages changes in dot-named siblings. |
| Any other file | Ignored. |

An installed package is a copy at `<config>/plugins/<id>`
(`tern plugin install`); a linked package stays where it is and is loaded
from there, which is what you want while developing it. See
[Distribution](../guides/distribution.md) and
[Command Line](../reference/cli.md).

### The data folder

Each plugin gets `<state>/plugin-data/<id>/`, created when one of its VMs
starts. Lua sees its absolute path as `tern.plugin.data`; programs run with
`tern.process.run` get it as the `TERN_PLUGIN_DATA` environment variable.
`tern.kv` keeps its values in `kv.json` there, rewritten through a temporary
file and a rename on every `tern.kv.set`.

Both halves of a plugin, and the window half in every window, share this
folder and one `tern.kv` store: each VM re-reads `kv.json` when the file's
modification time or length changed, so a `get` sees other VMs' writes and a
`set` never writes back a stale copy. Two `set`s at the same instant still
race, and the last rename wins. See
[Files, Processes, and Storage](../guides/io.md).

## Settings

Two keys in `<config>/settings.json` decide which plugins load. Each machine
reads its own settings; nothing syncs between hosts.

| Key | Default | Effect |
| --- | --- | --- |
| `plugins` | `true` | `false` loads no plugin at all. |
| `plugins_disabled` | `[]` | Plugin ids that stay unloaded (status Disabled). |

Preferences › Plugins edits both and reloads the plugins of the session and
the window when either changes. Both halves read `settings.json` again at
every load and reload (the daemon, the window, and a window's own host
runtime when no daemon runs), so a hand edit takes effect everywhere at the
next reload. A headless run (`tern shot`, `tern serve`) loads plugins only
with the `plugins fixtures` scenario command, which reads the two keys from
`settings.json` too.

## Ids and names

Plugin, block and lens ids all match `^[a-z][a-z0-9-]{0,31}$`: a lowercase
letter, then up to 31 lowercase letters, digits or `-`. Block and lens ids
are unique within their plugin. Everything a plugin contributes is named
after its id:

| Thing | Name | Used in |
| --- | --- | --- |
| Block type (kind) | `<plugin>.<block>` | `cx:new_block`, `launch.block`, route decisions `{block = …}` |
| Block surface role | `plugin.<plugin>.<block>` | CSS `[data-surface='plugin.k8s.pods']`, set on the block's region elements |
| Lens id | `plugin.<plugin>.<lens>` | Lens blocks: a block's role is `lens.` followed by its lens id |
| Lens block role | `lens.plugin.<plugin>.<lens>` | CSS `.sf-block[data-role='lens.plugin.k8s.get']` |
| Command action | `plugin.<plugin>.<id>` | `tern.bind`, `keybinds` in `settings.json`, status segment `command` |
| Function bind action | `plugin.<plugin>.bind.<n>` | The `n`th function passed to `tern.bind`, counted from 0 |
| Manifest styles sheet | `plugin:local:<plugin>:styles` | Style cascade, after Tern's own sheets |
| `tern.css` sheet | `plugin:local:<plugin>:<name>` | Style cascade |
| Remote host's styles sheet | `plugin:<host>:<plugin>:styles` | Style cascade |
| Data folder | `<state>/plugin-data/<plugin>` | `tern.plugin.data`, `TERN_PLUGIN_DATA` |

Command ids (`tern.command`) and sheet names (`tern.css`) are looser: ASCII
letters, digits, `_` and `-`. A command cannot be called `bind`, and a sheet
cannot be called `styles`.

## Modules and `require`

`require("tern")` returns the `tern` table, which is also the global `tern`.
Any other string is a path relative to the file that calls `require`:

| Call | Loads |
| --- | --- |
| `require("./util")` | `util.luau`, `util.lua`, `util/init.luau` or `util/init.lua` beside the caller |
| `require("./lib/pods")` | `lib/pods.luau` (or the other three forms) |
| `require("../shared")` | One directory up, if that is still inside the package |

A path that resolves to more than one of those files is an error, as is one
that leaves the package directory. `.luaurc` files and `@alias` paths are not
read. Modules are cached per resolved file within a VM, so each half loads a
shared module once. See [Runtime, Budgets, and JIT](runtime.md#modules).

## Styles

The files listed in `styles` are read when the package loads, joined with
newlines, and capped at 256 KiB in total; a missing file or an oversized
total is a problem with the package. On this machine the window runtime
installs them as the global sheet `plugin:local:<id>:styles`, after Tern's
own sheets, for every plugin the settings allow, whether or not it has a
window entry and before that entry runs. Remote hosts'
Ready plugins' styles arrive in their catalogs and are installed as
`plugin:<host>:<id>:styles`. A window half can add more sheets at run time
with `tern.css`. See [Chrome and Styling](../guides/chrome.md).

## Problems and statuses

A folder that cannot be a plugin is a **problem**: it is listed with its
error and loads nothing. A valid package has a **status**.

| Problem | Cause |
| --- | --- |
| `no plugin.toml` | A directory without a manifest. |
| `plugin.toml is larger than 64 KiB` | The manifest is too large. |
| A manifest rule, such as `unsupported schema 2`, `invalid id "X"`, `needs a host or window entry`, `blocks need a host entry` | The manifest breaks a schema-1 rule ([Manifest Reference](../reference/manifest.md)). |
| `missing entry host.luau` | A named entry file does not exist. |
| `cannot read style k8s.css: …`, `styles are larger than 256 KiB` | A style sheet is unreadable, or the total is too large. |
| `link target … is not an absolute path`, `link target … is not a directory` | A `.path` file names something unusable. |
| `duplicate id k8s` | An earlier entry in name order already has this id. |
| `too many plugins` | More than 64 valid packages; packages are sorted by id and those past the 64th are left out. |

| Status | Meaning |
| --- | --- |
| Ready | Loaded; its entries ran. |
| Disabled | Turned off by `plugins` or `plugins_disabled`. |
| Failed | An entry raised while loading, or left a declared block or lens undefined; the error is kept. |

Problems and statuses appear in `tern plugin list`, in Preferences › Plugins,
and as a toast when a host's catalog changes. See
[Lifecycle and Reload](lifecycle.md#the-catalog-and-statuses) for where each
half's status comes from.

## Related pages

- [Manifest Reference](../reference/manifest.md): every key and rule.
- [Lifecycle and Reload](lifecycle.md): when packages are read again.
- [Limits](../reference/limits.md): sizes and counts in one table.
