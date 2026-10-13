# Distribution

A plugin ships as a directory with `plugin.toml` at its root, usually a git
repository. Users install it with `tern plugin install`, which copies it into
their plugins folder; while you develop, `tern plugin link` loads it from
where it is. This page covers laying out a repository, every `tern plugin`
verb that changes the folder, turning plugins on and off, versioning, and
where to install for iOS and remote hosts.

```sh
tern plugin install github.com/you/tern-k8s
```

## Packaging a repository

`install` takes the package from the root of the source: the repository root
(or the directory given) must hold `plugin.toml`. There is no way to name a
subdirectory, so publish one plugin per repository.

```text
tern-k8s/
  plugin.toml
  host.luau
  window.luau
  lib/
    pods.luau
  k8s.css
  README.md
  LICENSE
```

Everything in the source is copied except `.git` directories, so the
installed package carries your README, tests and screenshots too. The loader
reads only `plugin.toml`, the entries, the modules they `require`, the
`styles` files, and whatever handlers read with `tern.fs`; the rest only
takes space. Keep large assets and build output out of the repository: the
package directory is watched for changes, and on Linux and iOS large trees
cost watches and polling (see [Lifecycle and
Reload](../concepts/lifecycle.md#watching)).

Files a plugin writes at run time belong in `tern.plugin.data`, never in the
package: an install replaces the package directory, and any change inside it
reloads the plugin.

If you commit the `tern.d.luau` that `tern plugin types` writes, it is copied
with the rest; nothing reads it at run time. Many authors ignore it and let
each contributor generate it for their Tern version.

## Installing

```sh
tern plugin install SRC [--force]
```

`SRC` is a git URL or a local directory:

| SRC | Treated as |
| --- | --- |
| Starts with `https://`, `http://`, `git@` or `ssh://` | A git URL, cloned as written. |
| Starts with `github.com/` | `github.com/OWNER/REPO`, cloned from `https://github.com/OWNER/REPO`; anything after `REPO` is the package's directory in it (`github.com/stencil-hq/tern-sdk/plugins/examples/jsonx`). |
| Anything else | A directory, relative to the current directory. |

A git source is cloned shallowly (`--depth 1`) from the default branch into
a temporary directory, which is removed afterwards. Installing needs `git` on
`PATH` (`installing from git needs git` otherwise). Git runs with terminal
prompts off, so a repository that needs a password fails rather than asking;
use an SSH URL with a loaded key or a credential helper for private
repositories. A failed clone reports `git clone URL failed:` and git's
message. To install a tag or branch other than the default, clone it
yourself and install the directory.

Before copying, `install` checks the package without running any Lua:
`plugin.toml` must parse under schema 1, and the `host` and `window` entries
and every `styles` file must exist. A package that fails reports `DIR is not
a plugin: WHY`. Lua errors show only once the plugin loads, so read what the
command prints after the copy.

The package is installed as `<plugins>/<id>`, named after its manifest `id`
whatever the source directory is called:

1. The source is copied, following symbolic links and leaving out `.git`,
   into a dot-named staging directory beside the destination (the loader
   skips dot names, so a half-finished copy is never loaded).
2. An existing copy is moved aside to another dot-named directory, the new
   copy is renamed into place, and the old one is removed. If the rename
   fails, the old copy is moved back.

Installing an id that is already installed fails with `ID is already
installed (DIR); --force replaces it`. With `--force`, the new copy replaces
the old; if the old one lived in a directory with another name, that
directory is removed. A linked package is never replaced: with or without
`--force`, `install` fails with `ID is linked (DIR); use unlink first`.

```text
$ tern plugin install ~/src/tern-k8s
installed k8s 0.3.0 → /Users/me/Library/Application Support/Tern/plugins/k8s
```

After the change the command has the session daemon reload its plugins and
prints any plugin that failed and any problem in the folder. With no daemon
running it prints `no daemon running; changes apply at next start`. Windows
on the machine reload their window halves from their own watch of the
folder. See [Lifecycle and Reload](../concepts/lifecycle.md#reloading).

Preferences › Plugins has the same install as **Install…**: a directory or
git URL, copied into the plugins folder. It never replaces an installed
copy (there is no `--force`). A leading `~` in a directory is the home
directory, there and on the command line.

## Linking for development

```sh
tern plugin link ~/src/tern-k8s
```

`link DIR` validates the package as `install` does, then writes
`<plugins>/<id>.path` holding the directory's absolute path. Tern loads the
package from there and watches that directory, so saving a file reloads the
plugin. Linking again with another directory moves the link. Linking fails
when a different package with that id is installed (`ID is already installed
(DIR)`).

`tern plugin unlink ID` removes the `.path` file and leaves your directory
alone. It fails for an installed copy (`ID is installed, not linked; use
remove`).

## Removing

`tern plugin remove ID` deletes the installed copy and reloads, as `install`
does. It refuses a linked package (`ID is linked; use unlink`). The plugin's
data folder, `<state>/plugin-data/<id>/` with its `kv.json`, is kept, so a
reinstall finds its state again; delete it by hand to start fresh.

Blocks of a removed plugin's types end when the host reloads, with `no block
type KIND on this host`.

## Where the folder is

`tern plugin dir` prints the plugins folder (`<config>/plugins`; see
[Packages and Manifests](../concepts/packages.md#directories)). Every
`tern plugin` verb takes `--json` and `--window KEY`.

| Verb | Prints |
| --- | --- |
| `dir` | The folder. |
| `install SRC [--force]` | `installed ID VERSION → DIR` |
| `link DIR` | `linked ID VERSION → DIR` |
| `unlink ID` | `unlinked ID (FILE)` |
| `remove ID` | `removed ID (DIR)` |

See [Command Line](../reference/cli.md) for every verb and its output.

## Turning plugins on and off

Two settings decide what loads on a machine:

```json
{
	"plugins": true,
	"plugins_disabled": ["k8s"]
}
```

`plugins = false` loads none. An id in `plugins_disabled` stays installed
but unloaded: status `disabled` in `tern plugin list`, Off in Preferences.
A disabled plugin runs no Lua, installs no styles, and its block types are
gone from that host.

Preferences › Plugins has a switch for the master setting and one per
plugin; flipping either saves the settings and reloads the plugins of the
window and its daemon. After editing `settings.json` by hand, run **Reload
settings** and then **Reload plugins** from the palette: the daemon reads
the file at every reload, but a window uses the settings it holds until
told to read them again.

Settings are per machine. Turning a plugin off on your laptop doesn't turn
it off on a remote host.

## Versioning

`version` in the manifest is free-form text. Tern shows it in `tern plugin
list`, Preferences and the install output, and never compares it: there is
no update command and no dependency resolution. Users update by installing
again with `--force`, or with `git pull` in a linked checkout.

Practical rules:

- Bump `version` with every release, so users and bug reports can say what
  they run.
- Keep the default branch installable: `install` clones its tip. Tag
  releases for users who want to pin one.
- `schema = 1` is the manifest format, not your version; leave it.
- The plugin API has no version number. Members that a Tern release adds are
  absent in older ones, so test with `if tern.chrome then … end` style checks
  when you rely on something new.
- Keep saved state readable across versions. An install reloads the host, and
  running blocks restart under the new code with the state the old code's
  `save` returned. Data in `tern.kv` and the data folder carries over too;
  store a format number beside it when its shape may change.

## iOS

Tern on iPhone and iPad has no command line and no `git`. Its plugins folder
is the app's `Documents/Plugins`, which the Files app shows as On My iPhone
(or iPad) › Tern › Plugins; Preferences › Plugins says where. Copy a
package folder there with Files (from iCloud Drive, a share or AirDrop), then
use the page's Reload button or the palette's **Reload plugins**; the folder
is also polled for changes every two seconds.

iOS runs window halves only, and interprets them (no JIT). Host entries are
skipped: blocks and lenses come from the hosts the app is attached to, and
appear as long as those hosts have the plugin installed. `tern.process.run`
raises on iOS, so a window half meant for both checks first:

```lua
if tern.runtime.os ~= "ios" then
	tern.process.run({ "git", "status", "--short" }, nil, function(result, _cx)
		tern.log.warn("git status", result.status)
	end)
end
```

See the [Support Matrix](../concepts/support-matrix.md).

## Remote hosts

Each half runs where its context is, so install each half on the machine
that runs it:

| Half | Install on |
| --- | --- |
| Host half (blocks, lenses, hooks, the `spawn` filter) | The machine whose panes it serves. For a remote host, that host. |
| Window half (commands, keys, routes, chrome, layout) | The machine showing the windows. It applies to every pane in them, remote ones included. |
| Manifest `styles` | Either. A remote host's Ready plugins install their manifest styles in your windows. |

To install on a remote host, run `tern plugin install` in a pane on that
host: the `tern` there installs into that machine's plugins folder and
reloads that host's daemon. A plugin with both halves that you want for
remote panes needs installing on both machines. The remote host's plugins
show read-only under its name in your Preferences › Plugins, and the
palette's **Reload plugins** reloads every attached host.

A remote host's window halves don't run in your windows, and its `tern.css`
sheets don't reach them; only its manifest styles do. See
[Architecture](../concepts/architecture.md#where-each-half-runs) and
[Chrome and Styling](chrome.md#global-css).

## Trust

Installing a plugin runs its code with your account's access: `tern.fs` and
`tern.process` reach anything you can. Read a plugin before installing it,
and prefer sources you can review at the commit you install. See
[Trust and Security](../concepts/security.md).

## See also

- [Packages and Manifests](../concepts/packages.md): the package layout and
  manifest.
- [Command Line](../reference/cli.md): `tern plugin` in full.
- [Debugging](debugging.md): reading what an install printed.
