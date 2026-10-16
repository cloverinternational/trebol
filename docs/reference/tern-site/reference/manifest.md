# Manifest Reference

`plugin.toml` declares a package: its identity, its entries, its style
sheets, and the block types and command lenses its host half defines. Every
replica of a host learns these declarations from the catalog without running
any Lua, so the manifest is what decides which commands a plugin claims and
which block types the palette offers.

This page lists every key with its type, default and validation rule, and
the exact text each rule fails with. For the concepts behind them see
[Packages and Manifests](../concepts/packages.md).

## Example

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

[[blocks]]
id = "logs"
title = "Logs"
icon = "file"
palette = false

[[lenses]]
id = "get"
match = ["kubectl get *", "k get *"]
```

## How the manifest is read

The manifest is checked in two steps:

1. **Text rules**, which need only the file: size, TOML syntax, schema, key
   names and types, ids, name length, entry and style paths, and the
   `[[blocks]]`/`[[lenses]]` rules. `tern plugin install` and
   `tern plugin link` apply them before touching the plugins folder.
2. **Package rules**, which need the package directory: the named entry files
   exist, and the style sheets can be read and fit the size cap. The loader
   applies them every time it scans the plugins folder.

The first rule broken is the only one reported. A package that breaks a rule
is a **problem**, listed with the message in `tern plugin list`, Preferences ›
Plugins and the "plugins have problems" toast; it loads nothing. Messages
below are quoted as the loader reports them; `tern plugin install` and
`link` prefix them with `<dir> is not a plugin: ` (see
[Command Line](cli.md#errors)).

Unknown keys are errors, at the top level and in every `[[blocks]]` and
`[[lenses]]` table. A misspelled key fails the package instead of being
ignored.

## Top-level keys

| Key | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `schema` | integer | yes | | Must be `1` |
| `id` | string | yes | | `^[a-z][a-z0-9-]{0,31}$`; unique among installed packages |
| `name` | string | yes | | 1–64 characters |
| `version` | string | yes | | Free-form |
| `description` | string | no | `""` | Free-form, one line |
| `icon` | string | no | `"puzzle"` | A Tern icon name; unknown names become `puzzle` |
| `host` | string | one of `host`, `window` | absent | Relative path inside the package, ending `.luau` or `.lua` |
| `window` | string | one of `host`, `window` | absent | Relative path inside the package, ending `.luau` or `.lua` |
| `styles` | array of strings | no | `[]` | Each a relative path inside the package; 256 KiB in total |
| `blocks` | array of tables (`[[blocks]]`) | no | `[]` | Requires `host` |
| `lenses` | array of tables (`[[lenses]]`) | no | `[]` | Requires `host` |

### `schema`

The manifest format version. Only `1` exists. The check runs before any
other key is read, so a future schema fails with a clear message rather than
a list of unknown keys.

| Manifest | Message |
| --- | --- |
| No `schema` key | `missing schema` |
| `schema = 2` | `unsupported schema 2` |
| `schema = "1"` | `schema must be an integer` |

### `id`

The plugin's identity on the machine. It names everything the plugin
contributes: block kinds `<id>.<block>`, lens ids `plugin.<id>.<lens>`,
actions `plugin.<id>.<command>`, style sheets `plugin:local:<id>:…`, and the
data folder `<state>/plugin-data/<id>`. See
[Packages and Manifests](../concepts/packages.md#ids-and-names).

The id must be 1–32 bytes: a lowercase ASCII letter, then lowercase letters,
digits or `-`.

| Manifest | Message |
| --- | --- |
| `id = "K8s"`, `id = "1x"`, a 33-character id | `invalid id "K8s" (lowercase letters, digits and -, 1-32 long)` |
| Another package earlier in name order has the same id | `duplicate id k8s` (reported for the later directory) |

The directory name doesn't have to match the id; `tern plugin install`
names its copy after the id.

### `name`

The display name: the palette group of the plugin's commands, the first
line of its toasts ("Plugin *name*: *hook* failed"), Preferences and
`tern plugin list`. It is counted in Unicode characters, not bytes.

| Manifest | Message |
| --- | --- |
| `name = ""`, or longer than 64 characters | `name must be 1-64 characters` |

### `version`, `description`

Free-form strings shown in `tern plugin list` (version only) and
Preferences. Tern never compares versions.

### `icon`

An icon from Tern's set ([Icon names](../elements/data.md#icon-names): `box`,
`sparkle`, `terminal`, `chev-r`, …), or one of the aliases
Tern accepts for omp (`success`, `git-branch`). Anything up to the last `.`
is ignored, so `icon.folder` is `folder`. An unknown or absent name becomes
`puzzle`; this is not an error. The catalog carries the resolved name.

### `host`, `window`

The two entries. At least one must be present. Each is a path relative to
the package directory, made only of normal components and `.` (no `..`, no
root, no drive), ending in `.luau` or `.lua`.

| Manifest | Message |
| --- | --- |
| Neither key | `needs a host or window entry` |
| `host = "../h.luau"`, `host = "/abs/h.luau"`, `host = ""` | `host "../h.luau" must be a relative path inside the plugin` |
| `window = "w.js"` | `window "w.js" must be a .luau or .lua file` |
| The file does not exist | `missing entry host.luau` |

`host` runs in the host context: the worker that owns blocks, lenses, host
events and the `spawn` filter. `window` runs in every Tern window. See
[Architecture](../concepts/architecture.md#the-two-halves).

### `styles`

CSS files, each a relative path inside the package (same rule as the
entries, any extension). They are read in order, joined with a newline
between files, and installed as one global sheet `plugin:local:<id>:styles`
in every window that allows the plugin, before its window entry runs and
whether or not it has one. See [Chrome and Styling](../guides/chrome.md).

| Manifest | Message |
| --- | --- |
| `styles = ["../x.css"]` | `style "../x.css" must be a relative path inside the plugin` |
| A file cannot be read | `cannot read style k8s.css: <io error>` |
| The joined text exceeds 256 KiB | `styles are larger than 256 KiB` |

CSS parse errors are not manifest errors: the sheet installs and the window
logs `plugin style sheet has errors`.

## `[[blocks]]`

Each table declares one block type, kind `<plugin>.<id>`. The host entry
must define it with
[`tern.block.define`](api-host.md#ternblockdefine); the declaration is what
the palette, "Open with" menus and route decisions see on every replica.

| Key | Type | Required | Default | Rule and meaning |
| --- | --- | --- | --- | --- |
| `id` | string | yes | | `^[a-z][a-z0-9-]{0,31}$`, unique among this plugin's blocks |
| `title` | string | yes | | Palette row "New *title* block", "Open with *title*", and the pane title until the block's `title` handler returns one |
| `icon` | string | no | The plugin's icon | An icon name as for the top-level `icon`; unknown becomes `puzzle` (not the plugin's icon) |
| `files` | array of strings | no | `[]` | File-name globs; a matching file offers "Open with *title*" |
| `palette` | boolean | no | `true` | Whether the palette offers "New *title* block" |

`files` globs are matched against the file's name only (not its directory),
ignoring ASCII case: `*.yaml` matches `Deploy.YAML`. "Open with *title*"
starts the block beside the focused pane, in the file's folder, with the
file's path as its only argument. The menu lists only block types of Ready
plugins on the host the current session runs on.

| Manifest | Message |
| --- | --- |
| `[[blocks]]` without `host` | `blocks need a host entry` |
| `id = "Pods"` | `invalid block id "Pods"` |
| Two tables with the same `id` | `duplicate block id "pods"` |
| Missing `title` | ``missing field `title` `` |
| Unknown key | ``unknown field `shape`, expected one of `id`, `title`, `icon`, `files`, `palette` `` |

The plugin's entry must agree with the declarations; these fail the plugin
(status Failed) rather than the package:

| Entry | Error |
| --- | --- |
| `tern.block.define("x", …)` for an undeclared id | `tern.block.define: block "x" is not declared in plugin.toml` (raised in the entry) |
| A declared id never defined | `block x is declared in plugin.toml but not defined with tern.block.define` |

## `[[lenses]]`

Each table declares one command lens, id `plugin.<plugin>.<id>`, and the
globs over command lines it claims. The host entry must define it with
[`tern.lens.define`](api-host.md#ternlensdefine).

| Key | Type | Required | Default | Rule and meaning |
| --- | --- | --- | --- | --- |
| `id` | string | yes | | `^[a-z][a-z0-9-]{0,31}$`, unique among this plugin's lenses |
| `match` | array of strings | yes | | At least one glob over `program args…` |

### Match patterns

A command the shell reports (OSC 133) is first read as a simple command:

- leading `VAR=value` assignments are skipped;
- wrapper programs are skipped with their options: `sudo`, `doas`, `exec`,
  `time`, `nice`, `nohup`, `env`, `command`, `builtin`, `caffeinate`, `npx`,
  `bunx`, `pnpx`, `uvx`, `pipx`;
- the program loses its directories (`/usr/bin/git` is `git`);
- quotes and escapes are removed and redirections dropped;
- a line whose output isn't one program's is never claimed: pipelines,
  lists (`;`, `&&`, `||`), stdout redirections, subshells, heredocs, and
  command substitution in the program word.

The program and its arguments are joined with single spaces, and each
pattern must match that whole text. `*` matches any run of characters
(including none), `?` exactly one, and every other character itself.
Matching is case-sensitive.

| Pattern | Command line | Claimed |
| --- | --- | --- |
| `kubectl get *` | `kubectl get pods` | yes |
| `kubectl get *` | `FOO=1 sudo kubectl get pods -A` | yes |
| `kubectl get *` | `kubectl get` | no (the space must be there) |
| `kubectl get *` | `kubectl get pods \| grep x` | no (pipeline) |
| `kubectl get *` | `Kubectl get pods` | no (case) |
| `kubectl *` | `kubectl logs x` | yes |

A pattern that names a shell alias doesn't see through it: the line is
matched as the shell reported it. List alias forms as extra patterns
(`"k get *"`).

### Claim order

When several lenses match, the first Ready plugin by id wins, and within it
the first lens in manifest order whose patterns match. Disabled and Failed
plugins claim nothing. A plugin's claim takes precedence over Tern's
built-in lenses. Order lenses from most to least specific.

| Manifest | Message |
| --- | --- |
| `[[lenses]]` without `host` | `lenses need a host entry` |
| `id = "Get"` | `invalid lens id "Get"` |
| Two tables with the same `id` | `duplicate lens id "get"` |
| `match = []` | `lens "get" needs at least one match pattern` |
| Missing `match` | ``missing field `match` `` |

| Entry | Error |
| --- | --- |
| `tern.lens.define("x", …)` for an undeclared id | `tern.lens.define: lens "x" is not declared in plugin.toml` (raised in the entry) |
| A declared id never defined | `lens x is declared in plugin.toml but not defined with tern.lens.define` |

## TOML and type errors

Syntax and type errors carry the TOML parser's message without a location:

| Manifest | Message |
| --- | --- |
| `name =` (no value) | `string values must be quoted, expected literal string` |
| A line `not toml =` | ``key with no value, expected `=` `` |
| `id = 5` | ``invalid type: integer `5`, expected a string`` |
| `palette = "no"` | `invalid type: string "no", expected a boolean` |
| `version` missing | ``missing field `version` `` |
| `color = "red"` | ``unknown field `color`, expected one of `schema`, `id`, `name`, `version`, `description`, `icon`, `host`, `window`, `styles`, `blocks`, `lenses` `` |

## File and folder rules

| Rule | Message |
| --- | --- |
| `plugin.toml` larger than 64 KiB | `plugin.toml is larger than 64 KiB` |
| A directory without `plugin.toml` | `no plugin.toml` |
| `plugin.toml` unreadable (permissions, not UTF-8) | `cannot read plugin.toml: <io error>` |
| More than 64 valid packages | `too many plugins` for each package past the 64th by id |

`<name>.path` files in the plugins folder link a package kept elsewhere; their
own messages (`cannot read link: …`, `link target "x" is not an absolute
path`, `link target /x is not a directory`) are listed in
[Errors](errors.md#plugins-folder-problems).

## Related pages

- [Packages and Manifests](../concepts/packages.md) for layout, folders and
  settings.
- [Limits](limits.md) for every size and count.
- [Command Line](cli.md) for installing and linking packages.
