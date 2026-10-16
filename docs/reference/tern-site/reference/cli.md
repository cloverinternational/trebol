# Command Line

`tern plugin` manages the packages in this machine's plugins folder and asks
the session daemon to reload them. It works on files and on the running
daemon only; it never runs plugin Lua itself. iOS has no command line: copy
packages into the Files app's Tern › Plugins folder instead.

## Synopsis

```sh
tern plugin list [--json]
tern plugin reload [--json]
tern plugin dir [--json]
tern plugin install SRC [--force] [--json]
tern plugin remove ID [--json]
tern plugin link DIR [--json]
tern plugin unlink ID [--json]
tern plugin types DIR [--json]
tern plugin --help
```

## Common behavior

| Flag | Meaning |
| --- | --- |
| `--json` | Print the result as pretty-printed JSON instead of text |
| `--window KEY` | Accepted as by every `tern` command (the window whose daemon connection is used: `--window`, else `$TERN_WINDOW_KEY`, else the first window). There is one daemon per user, so it doesn't change which plugins a verb sees |
| `--help`, `-h` | Print the usage below and exit 0 |

Flags may come before or after the words, and `--name=value` works for
`--window`. Any other flag is a usage error. The plugins folder belongs to
the machine, not to a window, which is why `tern plugin --help` has no
window note.

"The daemon" is the session daemon on this machine's socket
(`$TERN_DAEMON_SOCKET`, else `daemon.sock` in the runtime or settings
directory). `tern plugin` never starts one.

### Exit codes

| Code | When |
| --- | --- |
| `0` | Success, including mutating verbs whose follow-up reload reported trouble |
| `1` | The verb failed (message on standard error); `reload` also exits 1 when the new catalog has a Failed plugin or a problem |
| `2` | A usage error: unknown flag, missing or extra words. The message is followed by the usage text |
| `124` | The daemon did not answer `reload` within 60 s |

Errors print as `tern plugin: <message>` on standard error.

### Reload after a change

`install`, `remove`, `link` and `unlink` change the plugins folder and then
ask the daemon to reload every plugin, waiting up to 60 s for the new
catalog. What they print after their own line:

| Outcome | Text mode (standard output) | `--json` (standard error) |
| --- | --- | --- |
| No daemon is running | `no daemon running; changes apply at next start` | same |
| The reload succeeded and everything loaded | nothing | nothing |
| Plugins failed or the folder has problems | One `list` line per Failed plugin, then `problem …` lines | same |
| The reload request failed | `the daemon did not reload its plugins: <error>` | same |

None of these change the exit code. Windows reload their own window halves
when they see the folder change; see
[Lifecycle and Reload](../concepts/lifecycle.md#watching).

## `tern plugin list`

Prints the running daemon's catalog as it was when the command connected:
every installed plugin with its status, then the folder's problems. With no
daemon, it reads the plugins folder and settings directly without running
any Lua: every valid package the settings allow is `ready`. A window entry
that fails to load is never shown as failed here, because the host's catalog
doesn't know about it.

Text output, one line per plugin, then one per problem:

```text
hello 0.1.0 Hello — 1 blocks, 1 lenses, window  ready
k8s 0.3.0 Kubernetes — 2 blocks, 1 lenses  disabled
jsonx 1.0.0 JSON Explorer — 0 blocks, 1 lenses  failed: lens tree is declared in plugin.toml but not defined with tern.lens.define
problem /Users/me/Library/Application Support/Tern/plugins/broken: no plugin.toml
```

| Part | Meaning |
| --- | --- |
| `ID VERSION NAME` | From the manifest |
| `— N blocks, M lenses` | Counts of `[[blocks]]` and `[[lenses]]` |
| `, window` | Present when the manifest has a `window` entry |
| Status (after two spaces) | `ready`, `disabled`, or `failed: ` and the first line of the error |
| `problem DIR: ERROR` | A folder entry that is not a usable plugin |

An empty folder prints `no plugins`. Exit code 0.

`--json` prints the catalog:

```json
{
  "plugins": [
    {
      "id": "hello",
      "name": "Hello",
      "version": "0.1.0",
      "description": "The plugin fixture: a greeting lens, a counter block and a few hooks.",
      "icon": "sparkle",
      "css": "…",
      "blocks": [
        { "id": "counter", "title": "Counter", "icon": "sparkle", "files": ["*.json"], "palette": true }
      ],
      "lenses": [{ "id": "greet", "patterns": ["tern-hello *"] }],
      "host": true,
      "window": true,
      "status": "ready"
    }
  ],
  "problems": [{ "dir": "/…/plugins/broken", "error": "no plugin.toml" }],
  "jit": false
}
```

| Field | Meaning |
| --- | --- |
| `plugins[]` | Installed plugins, sorted by id |
| `.icon`, `.blocks[].icon` | Resolved icon names (`puzzle` for unknown) |
| `.css` | The manifest `styles`, concatenated |
| `.lenses[].patterns` | The manifest `match` globs |
| `.host`, `.window` | Whether each entry exists |
| `.status` | `"ready"`, `"disabled"`, or `{"failed": "<full error>"}` |
| `problems[]` | `{dir, error}` per unusable folder entry |
| `jit` | Whether the daemon runs Luau with native code generation; always `false` without a daemon |

## `tern plugin reload`

Has the daemon re-read `settings.json` and the plugins folder and reload
every plugin, then prints the new catalog as `list` does. Running blocks
restart from their last saved state; see
[Lifecycle and Reload](../concepts/lifecycle.md#reloading).

Exits 1 when a plugin is Failed or the folder has problems, after printing
the catalog, so scripts and CI can check a package:

```sh
tern plugin link . && tern plugin reload
```

| Error | Exit |
| --- | --- |
| `no daemon running` | 1 |
| `the session daemon did not answer` (60 s passed) | 124 |

## `tern plugin dir`

Prints the plugins folder: `<config>/plugins`, which is
`$TERN_CONFIG_DIR/plugins` when that variable is set. `--json` prints
`{"dir": "<path>"}`. The folder may not exist yet; `install` and `link`
create it. Fails with `no config directory for plugins` when the machine has
no configuration directory.

## `tern plugin install`

```sh
tern plugin install ./my-plugin
tern plugin install github.com/me/tern-k8s
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/jsonx
tern plugin install https://example.com/me/tern-k8s.git --force
```

Copies a package into the plugins folder as `<plugins>/<id>`, named after
the manifest id, then reloads.

`SRC` is a git source when it starts with `https://`, `http://`, `git@` or
`ssh://`, or is `github.com/OWNER/REPO[/PATH]` (`https://github.com/OWNER/REPO`
is cloned, and the package is its directory `PATH`).
Git sources are cloned with `git clone --depth 1 --quiet` into a temporary
directory, with `GIT_TERMINAL_PROMPT=0` so a private repository fails instead
of asking for a password. Anything else is a local directory, relative to
the current directory; a leading `~` or `~/` is the home directory (so a
quoted `~/src/plugin`, or one typed in Preferences, works). The package must
be at the root of the source, or of `PATH`.

The source is checked before anything is copied, by the loader's own check:
the manifest passes every
[text rule](manifest.md#how-the-manifest-is-read), the entries it names
exist, and the style sheets it names can be read and fit the size limit.
The copy follows symbolic links, leaves out
`.git`, is staged in a dot-named sibling the loader skips, and is renamed
into place; replacing an existing copy moves the old one aside first and
puts it back if the rename fails.

| Flag | Meaning |
| --- | --- |
| `--force` | Replace an installed package with the same id. If that package lives in a differently named folder inside the plugins folder, the old folder is removed after the new copy is in place |

Output: `installed ID VERSION → DIR`. `--json` prints
`{"id", "version", "dir"}`.

| Error | Cause |
| --- | --- |
| `ID is already installed (DIR); --force replaces it` | A package with this id, or a file or folder named `<id>`, is already there |
| `ID is linked (DIR); use unlink first` | The id is a linked package; `--force` never replaces a link |
| `no directory SRC: <io error>` | The local source does not exist |
| `SRC is not a directory` | The local source is a file |
| `DIR is not a plugin: no plugin.toml` | No manifest at the source's root |
| `DIR is not a plugin: <manifest message>` | A [manifest rule](manifest.md) fails, or `plugin.toml is larger than 64 KiB` |
| `DIR is not a plugin: missing entry FILE` | An entry named in the manifest is absent |
| `DIR is not a plugin: cannot read style FILE: <io error>` | A style sheet named in the manifest is absent or unreadable |
| `DIR is not a plugin: styles are larger than 256 KiB` | The style sheets together are too large |
| `installing from git needs git` | `git` is not on `PATH` |
| `git clone URL failed: <git's stderr>` | The clone failed |
| `no directory PATH in URL` | The clone has no `PATH` |
| `PATH is not a directory in URL` | `PATH` is a file, or leads out of the clone (through `..` or a symbolic link) |

## `tern plugin remove`

Deletes the installed package whose manifest id is `ID` (its folder inside
the plugins folder, whatever the folder is called; a symbolic link is removed
itself, not its target), then reloads. When no valid package has that id,
a file or folder named exactly `ID` in the plugins folder is removed instead,
which clears out a broken package.

Output: `removed ID (DIR)`. `--json` prints `{"removed": "<path>"}`.

| Error | Cause |
| --- | --- |
| `ID is linked; use unlink` | The id belongs to a linked package |
| `no plugin ID in DIR` | Nothing by that id or name |
| `no plugin id ID` | `ID` is empty, starts with `.`, or contains `/` or `\` |

## `tern plugin link`

```sh
tern plugin link ~/src/tern-k8s
```

Uses a package where it is: writes `<plugins>/<id>.path`, whose content is
the package's absolute, canonical path and a newline, then reloads. Tern
loads the package from that directory and watches it, so edits reload
without copying. This is the development setup; see
[Getting Started](../guides/getting-started.md).

The directory is checked as for `install`. Linking an id that is already
linked repoints the link.

Output: `linked ID VERSION → DIR`. `--json` prints `{"id", "version", "dir"}`.

| Error | Cause |
| --- | --- |
| `ID is already installed (DIR)` | An installed copy (not a link) has this id; `remove` it first |
| `DIR is not UTF-8` | The package path can't be written to a `.path` file |
| `no directory …`, `… is not a directory`, `… is not a plugin: …` | As for `install` |

## `tern plugin unlink`

Deletes the `.path` file that links `ID` (normally `<id>.path`, or whichever
`.path` file names the package's directory), then reloads. The package
directory itself is untouched.

Output: `unlinked ID (FILE)`. `--json` prints `{"removed": "<path>"}`.

| Error | Cause |
| --- | --- |
| `ID is installed, not linked; use remove` | The id belongs to a copy in the plugins folder |
| `no plugin ID in DIR` | Nothing by that id |
| `no plugin id ID` | `ID` is empty, starts with `.`, or contains `/` or `\` |

## `tern plugin types`

```sh
tern plugin types .
```

Writes `DIR/tern.d.luau`, the Luau definition file for the `tern` module
that this Tern ships, creating `DIR` if needed (relative to the current
directory). It overwrites an existing file. Output: `wrote FILE`; `--json`
prints `{"file": "<path>"}`. It doesn't touch the plugins folder or the
daemon. See [API Reference](api.md#types-for-luau-lsp) for the luau-lsp
settings.

## Errors

Usage errors exit 2 and print the message, then the usage:

| Message | Cause |
| --- | --- |
| `tern plugin: plugin takes other arguments` | No verb, an unknown verb, or the wrong number of words (`tern plugin install` without `SRC`) |
| `tern plugin: unknown flag --NAME` | A flag the verb doesn't take (`--force` is `install`'s only flag) |
| `tern plugin: --window takes a value` | `--window` at the end of the line |

Every other failure exits 1 (or 124 for a timeout) with
`tern plugin: <message>`; the messages are in each verb's table above and in
[Errors](errors.md#command-line).

## Related pages

- [Distribution](../guides/distribution.md) for publishing packages.
- [Packages and Manifests](../concepts/packages.md#the-plugins-folder) for
  the folder layout and `.path` links.
- [Manifest Reference](manifest.md) for the rules `install` and `link` check.
