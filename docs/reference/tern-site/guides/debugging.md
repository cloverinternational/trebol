# Debugging

When a plugin misbehaves, Tern tells you in three places: toasts in the
window, the plugin catalog (`tern plugin list`, Preferences › Plugins), and
the log files. This page covers where each kind of failure shows, how to get
a plugin's own log lines, type-checking with luau-lsp, the developer tooling
that drives a window from a script, and the mistakes that cause most bugs.

## Where failures show

A failure is reported where the failing code runs, once per failure:

| Failure | Toast (text / second line) | Also |
| --- | --- | --- |
| A manifest or folder problem: no `plugin.toml`, an invalid id, a missing entry or style file, a duplicate id | "1 plugin has problems" or "*N* plugins have problems" / the first error | `problem DIR: ERROR` in `tern plugin list`; not listed as a plugin |
| A host entry raised while loading, or left a declared block or lens undefined | The same catalog toast | Status `failed` in `tern plugin list`, Failed in Preferences |
| A window entry raised while loading | "Plugin *name* failed to load" / the error's first line | Failed in Preferences; **not** in `tern plugin list` |
| A handler raised, returned the wrong shape, or ran over budget | "Plugin *name*: *hook* failed" / the error's first line | A `plugin handler failed` warning in the log, with the traceback |
| A chord or status segment names a plugin action that isn't loaded | "No plugin has this action" / the action name | |
| A status segment's `command` doesn't parse | "A status segment's command is unknown" / the command and why | |
| A `tern.bind` chord or action that doesn't parse, or keys the preset already binds | None | A `plugin bind left out` warning in the log |
| A style sheet with CSS errors | None | A `plugin style sheet has errors` warning naming the sheet |

The catalog toast appears when a host's catalog changes (when a window
attaches, and after a reload that changed it). A window reload that fails
with exactly the errors of the previous load doesn't toast them again, so a
broken plugin is reported once per change, not once per reload. Host
handler toasts go to the windows showing the pane concerned, or to every
window of the host for timers, process and fetch callbacks and the `spawn`
filter. See
[Runtime, Budgets, and JIT](../concepts/runtime.md#failures-and-toasts).

The hook in "Plugin *name*: *hook* failed" names the handler: `command
scratch`, `bind 0`, `override new_tab`, `route.open`, `status`, `timer`,
`counter.view`, `greet.line`, an event name. The full list is in
[Runtime, Budgets, and JIT](../concepts/runtime.md#a-tripped-budget).

## The catalog

`tern plugin list` prints the plugins of the session daemon serving the pane
it runs in, one line each, then one line per problem:

```text
hello 0.1.0 Hello — 1 blocks, 1 lenses, window  ready
problem /Users/me/Library/Application Support/Tern/plugins/broken: invalid id "Broken" (lowercase letters, digits and -, 1-32 long)
```

A line is `ID VERSION NAME — N blocks, M lenses[, window]  STATUS`, where
STATUS is `ready`, `disabled`, or `failed: ` and the error's first line.
`--json` prints the whole catalog, entries, problems and the host's `jit`
flag included.

What the statuses cover:

- The catalog is the **host's**. A window entry that fails to load leaves
  the plugin `ready` here; look in Preferences or the window's toasts.
- With no daemon running, `tern plugin list` reads the plugins folder
  without running any Lua: `ready` then only means the manifest is valid and
  the settings allow the plugin.

`tern plugin reload` has the daemon load every plugin again and prints the
new catalog. It exits 1 when a plugin failed or the folder has problems, so
it works as a check in a script or an editor task. It needs a running daemon
(`no daemon running` otherwise). `install`, `remove`, `link` and `unlink`
reload too, and print only what failed. See [Command Line](../reference/cli.md).

### Preferences › Plugins

The Plugins page lists this machine's plugins with a badge: Ready, Off, or
"Failed: " and the error's first line. The badge shows the worse of the
host's status and this window's, so a failing window entry shows here when
`tern plugin list` says `ready`. Each attached remote host's plugins follow
under the host's name, read-only. The page's Reload button reloads this
window's plugins and every attached host's, like the palette's **Reload
plugins** command.

## Logs

### Your own lines

`tern.log.debug`, `info`, `warn` and `error` write a line with target
`tern::plugin` and the field `plugin=<id>`; `print` is `tern.log.info`. The
default filter, `warn,stencil=info`, keeps Tern's own modules from info and
everything else from warn. `tern::plugin` isn't a Tern module, so **by
default only `tern.log.warn` and `tern.log.error` are written**; `print`,
`info` and `debug` are dropped.

The quickest way to see a value while developing is therefore
`tern.log.warn(...)`, or a toast from a window handler (`cx:toast("info",
text)`). To keep every level, start the process with `STENCIL_LOG`, which
replaces the filter for the log file and standard error:

```sh
STENCIL_LOG=warn,stencil=info,tern::plugin=debug
```

A process reads `STENCIL_LOG` when it starts. That matters for the host
half, which runs in the session daemon: the daemon is started by the first
window and keeps running after windows close, with the environment it
started with. To give host halves a filter of their own, run a separate
daemon. A window started with `TERN_DAEMON_SOCKET` naming a new socket
starts its own daemon there, which inherits the window's environment:

```sh
export STENCIL_LOG=warn,stencil=info,tern::plugin=debug
export STENCIL_LOG_DIR=/tmp/tern-plugin-logs
export TERN_DAEMON_SOCKET=/tmp/tern-plugin-dev.sock
tern ~/src/my-plugin
```

This window and its daemon log every plugin line to `/tmp/tern-plugin-logs`.
The panes it opens belong to that daemon, a session apart from your usual
one; `STENCIL_LOG_DIR` keeps the two daemons from writing the same file.
The window half logs at the same filter, since it runs in the window
process.

### Log files

| Platform | Log folder |
| --- | --- |
| macOS | `~/Library/Logs/Tern` |
| Linux | `$XDG_STATE_HOME/tern/logs` (`~/.local/state/tern/logs`) |
| Windows | `%LOCALAPPDATA%\Tern\Logs` |
| Any | `$STENCIL_LOG_DIR`, when set |

Host halves log to `tern-daemon.log` (to the window's `tern.log` when the
window runs its panes without a daemon); window halves log to `tern.log`. A
file moves to `<name>.1.log` at 16 MiB. The palette's **Open logs and app
state** writes out buffered lines and opens the log folder.

Tern's own reports about plugins are written at the default filter. Search
for these messages:

| Message | Means |
| --- | --- |
| `plugin handler failed` | A handler raised; the line has `plugin`, `hook` and the error with its traceback. |
| `plugin hook exceeded its budget; disabled until reload` | A budget tripped. |
| `plugin failed to load` | A host entry failed. |
| `plugin window entry failed to load` | A window entry failed. |
| `not a usable plugin` | A folder problem. |
| `plugin bind left out` | A chord or action didn't parse, or the preset binds the keys. |
| `plugin style sheet has errors` | CSS that didn't parse, with the sheet name. |
| `plugin spawn filter took over 50 ms; skipped` | A slow `spawn` filter. |
| `plugin keeps re-rendering; requests dropped` | A block asked for renders in a loop. |

## Budgets as a signal

A handler that runs past its budget raises `tern: <hook> exceeded <n> ms`,
is toasted once, and its hook is then **disabled until the next reload**.
Later calls are skipped without a toast. The symptom is a command, binding,
formatter or block view that worked once, raised one toast, and then
silently does nothing. A window logs each skipped call as `plugin handler
failed` with the error `tern: <hook> is disabled after exceeding its
budget`; a host logs `disabled plugin hook skipped` at debug level.

| Budget | Applies to |
| --- | --- |
| 4 ms | Chrome formatters and `available` checks |
| 50 ms | Every other window call, the window entry included |
| 2 s | Every host call, the host entry included |

A trip almost always means work in the wrong place: a file walk or a large
read in a window handler, a parse that grows with its input, a loop waiting
for something. Because the hook is the unit, one slow timer callback
disables every timer callback of that plugin in that VM. Fix the cause and
reload: the palette's **Reload plugins**, `tern plugin reload`, or saving a
file in the package. Move slow work into `tern.process.run`, spread it over
`tern.timer` callbacks, or move it to the host half. See [Runtime, Budgets,
and JIT](../concepts/runtime.md#budgets).

## Type-checking with luau-lsp

`tern plugin types DIR` writes `DIR/tern.d.luau`, the definitions of the
whole `tern` module. Point luau-lsp at it in the package directory:

```sh
cd ~/src/my-plugin
tern plugin types .
```

`.vscode/settings.json` (or your editor's luau-lsp settings):

```json
{
  "luau-lsp.platform.type": "standard",
  "luau-lsp.sourcemap.enabled": false,
  "luau-lsp.types.definitionFiles": { "@tern": "tern.d.luau" }
}
```

The same check on the command line:

```sh
luau-lsp analyze --platform=standard --definitions=@tern=tern.d.luau host.luau window.luau
```

Write the definitions again after upgrading Tern. Three things the checker
won't tell you:

- luau-lsp reports `require("tern")` as an unknown require. Use the global
  `tern`, which is the same table.
- The file declares one `tern` for both entries. Members of one context are
  marked `Host only` or `Window only` in their docs, but calling a host
  member from `window.luau` type-checks and fails at run time.
- Types are broader than the runtime in places: `cwd` in pane and tab
  tables is `string?` because the host's `tern.pane.list` can give `nil`,
  while the window's tables always hold a string (`""` when unknown).

## Driving a window from a script

Tern's developer tooling (`tern help dev`) can run a window with a control
endpoint and send it commands, including three for plugins:

| Command | Does |
| --- | --- |
| `plugins run <action>` | Runs an action by name, as a key bound to it would: `plugins run plugin.scratch.scratch`, `plugins run new_tab`. |
| `plugins expect "<text>"` | Waits until a surface of the focused pane (a plugin block's view, a lens block's native view) shows the text. |
| `plugins fixtures` | Replaces the plugins folder with Tern's test plugins and loads them, host halves included, under the `plugins` and `plugins_disabled` that `settings.json` saves. |

A window started with `--control` runs your plugins as usual, so `plugins
run` and `plugins expect` test a real package:

```sh
tern --control /tmp/tern-ctl.sock ~/src/my-plugin &
tern ctl --control /tmp/tern-ctl.sock plugins run plugin.counter.open
tern ctl --control /tmp/tern-ctl.sock plugins expect '"Count: 0"'
tern ctl --control /tmp/tern-ctl.sock css
tern ctl --control /tmp/tern-ctl.sock tree "[data-surface='plugin.counter.counter']"
```

[Scripts](../scripts/index.md) documents every command a script or `ctl` can
send.

`ctl` joins its words into one command line, so quote text that needs quotes
for the scenario parser inside shell quotes. Other control commands help with
styling: `css` lists the installed style sheets in cascade order (look for
`plugin:local:<id>:styles` and your `tern.css` names), `tree SEL` shows the
visible elements a selector matches, and `state` prints the app's state as
JSON.

`plugins fixtures` is for working on Tern itself. It loads the fixtures from
the source tree the binary was built in, and only in a process that runs its
panes itself: headless runs (`tern shot`, `tern serve`), which load no
plugins otherwise. In a window attached to a daemon it fails with `a daemon
runs this machine's panes, with its own plugins`. A scenario shows the
shape:

```text
ready
plugins fixtures
palette "New Counter"
key Enter
plugins expect "Count: 0"
type "+"
plugins expect "Count: 1"
shot plugin-block
```

## Common mistakes

### A `cx` kept for later

A window `cx` works only during the call that received it. Storing it in an
upvalue and using it from a timer, a process or fetch callback or a later
event raises an error. Timer, process and fetch callbacks get a fresh `cx`
of their own; use that one.

```lua
tern.on("window_start", function(_cx)
	tern.timer(1000, function(cx)
		if cx then
			cx:toast("info", "Use the cx you were given")
		end
	end)
end)
```

### Props under `--!strict`

A node's `p` is typed `{ [string]: any }?`, so `node.p.actions = …` fails to
type-check when `p` may be absent. Build the table, then assign it:

```lua
local node = tern.ui.badge("Retry", "accent")
local p: { [string]: any } = node.p or {}
p.actions = { click = "retry" }
node.p = p
```

Under `--!strict`, also keep span lists to spans only (a bare string mixed
in among span tables fails to check), and annotate series for bars and
sparklines as `local series: { { any } } = {}`. See
[UI Builders](../reference/ui.md).

### Styling blocks through `data-role`

A plugin block's kind is on its region elements as `data-surface`, not
`data-role`:

| Target | Selector |
| --- | --- |
| A plugin block | `.sf-main[data-surface='plugin.<plugin>.<block>']` (also `.sf-dock`, `.sf-layer`) |
| A lens block | `.sf-block[data-role='lens.plugin.<plugin>.<lens>']` |
| Your own nodes | `[data-role='…']` from the node's `role` prop |

`tern ctl tree SEL` against a `--control` window shows whether a selector
matches. See [Chrome and Styling](chrome.md#useful-selectors).

### Writing into the plugin directory

The package directory is watched, and any change there reloads every plugin
in that context. A plugin that writes a cache or log file next to its
entries reloads itself in a loop. Write to `tern.plugin.data`.

### Values that never change in a formatter

Chrome formatters are cached by their input. A formatter that reads the
clock, a file or a process result shows the first answer until its input
changes. Keep the data in an upvalue and call `tern.chrome.refresh()` when
it changes (from a timer for a clock). See
[Chrome and Styling](chrome.md#refreshing).

### A chord that does nothing

When the defaults or the `keymap` preset already bind a chord (or a sequence
it starts), a plugin's bind is left out with a `plugin bind left out`
warning and no toast. Pick chords the defaults leave free, or bind the
action in `settings.json` `keybinds`, which wins over every layer. See
[Commands, Keys, and Overrides](commands.md#keymap-layering).

### Checking the wrong machine

`tern.fs` and `tern.process` act on the machine their half runs on. A window
half reading `pane.cwd` for a pane on a remote host checks the window's
disk, not the host's. Put file checks for remote panes in the host half,
installed on that host.

## See also

- [Lifecycle and Reload](../concepts/lifecycle.md): when plugins load and
  reload.
- [Runtime, Budgets, and JIT](../concepts/runtime.md): budgets, toasts and
  log targets.
- [Errors](../reference/errors.md): error messages and their causes.
- [Command Line](../reference/cli.md): `tern plugin` in full.
