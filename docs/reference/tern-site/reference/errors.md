# Errors

Every message a plugin author or user can meet, grouped by where it
appears, with its cause and fix. Quoted text is exact; `<…>` marks the
variable parts. Most messages reach you through one of five channels:

| Channel | What lands there | Where to look |
| --- | --- | --- |
| Raised error | A call into `tern` rejected its arguments | The caller's handler fails; `pcall` catches it |
| Handler toast | A handler raised, tripped its budget, or returned a bad value | "Plugin *name*: *hook* failed", with the error's first line beneath |
| Problem | A folder entry is not a usable plugin | `tern plugin list`, Preferences › Plugins, the "plugins have problems" toast |
| Failed status | A plugin's entry did not load | `tern plugin list` (host), Preferences, "Plugin *name* failed to load" (window) |
| Log | Runtime reports, full error text with traceback | `tern-daemon.log` or the window's `tern.log`; see [Debugging](../guides/debugging.md) |

## Handler failures

When a handler raises, the call fails and nothing else does: the plugin
keeps running, and its state is whatever the handler left before raising.
Tern logs `plugin handler failed` (warn) with the plugin, the hook and the
full error with its traceback, and shows a toast:

```text
Plugin Kubernetes: pods.view failed
/Users/me/src/tern-k8s/host.luau:42: attempt to index nil with 'items'
```

The first line names the plugin (its manifest `name`) and the **hook**;
the second is the first line of the error. Hook names are listed in
[Runtime, Budgets, and JIT](../concepts/runtime.md#a-tripped-budget). Host
failures toast in the windows showing the pane concerned, or in every window
of the host for timers, process and fetch callbacks and `spawn`; window
failures toast in that window.

| Message | Cause | Fix |
| --- | --- | --- |
| `tern: <hook> exceeded <n> ms` | The call ran past its budget: 2000 (host), 50 (window) or 4 (formatters, `available`). Every later interrupt in that call raises again, so `pcall` can't recover | Move the work to `tern.process.run`, split it across `tern.timer` callbacks, or cap the input. The hook stays disabled in that VM until the next reload |
| `tern: <hook> is disabled after exceeding its budget` | A call of a hook that tripped earlier; skipped without running, logged at debug, never toasted | Fix the slow hook and reload |
| A Luau memory error | The VM reached 256 MiB | Keep less state; drop references to large strings and tables |
| `cx is already in use` | A window `cx` call made while another call of the same `cx` is still running (for example from a nested handler) | Use the `cx` your handler received, one call at a time |
| `the plugin is gone` | `tern.timer` was called after its VM was dropped (from a callback that outlived a reload) | None needed; the old VM is gone |

A block's `init` that raises also ends the block: the error and traceback
are printed in the pane and the pane exits with status 1.

## Load failures

A plugin whose entry fails is **Failed**; the others load normally.

| Message | Where | Cause | Fix |
| --- | --- | --- | --- |
| Toast "Plugin *name* failed to load", the error's first line beneath | Window | `window.luau` raised, tripped the 50 ms budget, or could not be read | Fix the entry; the toast repeats only when the failure changes |
| `failed: <first line>` in `tern plugin list`, status Failed in Preferences | Host | `host.luau` raised or tripped the 2 s budget | Fix the entry; reload |
| `block <id> is declared in plugin.toml but not defined with tern.block.define` | Host | The manifest declares a block the entry never defines | Call `tern.block.define("<id>", …)` in `host.luau`, or remove the `[[blocks]]` table |
| `lens <id> is declared in plugin.toml but not defined with tern.lens.define` | Host | Same for a lens | Call `tern.lens.define`, or remove the `[[lenses]]` table |
| `cannot read <path>: <io error>` | Either | The entry file vanished or is unreadable | Restore the file |
| `the plugin's worker stopped` | Host | The worker thread ended before reporting | Check the log for a crash |
| `cannot start the plugin's worker: <error>` | Host | The OS refused a new thread | Free resources; reload |
| Toast "1 plugin has problems" or "*N* plugins have problems", the first error beneath | Window | The host's catalog changed and holds problems or Failed plugins | Run `tern plugin list` to see them all |

Logged with them: `plugin failed to load` (host), `plugin window entry failed
to load` (window), `not a usable plugin` (each problem).

## Plugins folder problems

A folder entry that cannot be a plugin is listed as a problem with its
directory and loads nothing. Fixes are in the
[Manifest Reference](manifest.md).

| Message | Cause |
| --- | --- |
| `no plugin.toml` | A directory without a manifest at its top level |
| `cannot read plugin.toml: <io error>` | The manifest is unreadable or not UTF-8 |
| `plugin.toml is larger than 64 KiB` | |
| `missing schema`, `unsupported schema <n>`, `schema must be an integer` | `schema` is absent, not `1`, or not an integer |
| `invalid id "<id>" (lowercase letters, digits and -, 1-32 long)` | |
| `name must be 1-64 characters` | |
| `needs a host or window entry` | Neither `host` nor `window` |
| `<host\|window\|style> "<path>" must be a relative path inside the plugin` | An absolute path, `..`, or an empty path |
| `<host\|window> "<path>" must be a .luau or .lua file` | |
| `blocks need a host entry`, `lenses need a host entry` | `[[blocks]]` or `[[lenses]]` without `host` |
| `invalid block id "<id>"`, `duplicate block id "<id>"` | |
| `invalid lens id "<id>"`, `duplicate lens id "<id>"`, `lens "<id>" needs at least one match pattern` | |
| ``unknown field `<key>`, expected one of …``, ``missing field `<key>` ``, `invalid type: …` | TOML keys and types (the parser's text) |
| `missing entry <path>` | The `host` or `window` file does not exist |
| `cannot read style <path>: <io error>`, `styles are larger than 256 KiB` | |
| `duplicate id <id>` | An entry earlier in name order already has this id; remove or rename one |
| `too many plugins` | More than 64 valid packages; those past the 64th by id are left out |
| `cannot read link: <io error>` | A `<name>.path` file is unreadable |
| `link target "<text>" is not an absolute path` | A `.path` file's content is relative; relink with `tern plugin link` |
| `link target <dir> is not a directory` | A linked package moved or was deleted; `tern plugin unlink` or relink it |

## Registration errors

Raised by the registering call, usually while the entry loads (failing the
plugin) or from a handler.

| Message | Cause |
| --- | --- |
| `tern.block.define: block "<id>" is not declared in plugin.toml` | Declare the block in a `[[blocks]]` table first |
| ``tern.block.define: <id>: `<init\|view>` must be a function`` | A required handler is missing or not a function |
| `tern.lens.define: lens "<id>" is not declared in plugin.toml` | Declare the lens in a `[[lenses]]` table first |
| ``tern.lens.define: <id>: `<open\|line\|finish\|view>` must be a function`` | A required handler is missing or not a function |
| `tern.on: unknown host event "<name>" (spawn, command_started, command_finished, cwd, title, pane_exited)` | A name the host context doesn't deliver ([Events](events.md#host-events)) |
| ``tern.on: unknown window event `<name>` `` | A name the window context doesn't deliver ([Events](events.md#window-events)) |
| ``tern.command: bad id `<id>` (letters, digits, `_` and `-`; not `bind`)`` | |
| `tern.bind: the action is a name or a function` | The second argument is neither |
| ``tern.override: unknown command `<id>` `` | Not a built-in command id ([Built-in Actions](actions.md#commands)) |
| ``tern.css: bad name `<name>` (letters, digits, `_` and `-`; not `styles`)`` | |
| ``attempt to index nil with 'define'``, `attempt to call a nil value` | A member of the other context: `tern.block.define` in `window.luau`, `tern.command` in `host.luau` ([Contexts](api.md#contexts)) |

`tern.bind` checks nothing else at the call. When the keymap is rebuilt, a
bind whose chord or action doesn't parse is left out and logged as
`plugin bind left out` with the reason (``unknown action `<name>` ``,
``unknown modifier `<m>` ``); one whose keys the preset already binds is
logged as `plugin bind left out: the preset binds these keys`.

## Returned values

A handler that returns the wrong shape fails like a raised error, under its
hook name.

| Message | Hook | Cause |
| --- | --- | --- |
| `view: expected {main?, dock?, layer?}, got <value>` and the node errors listed under [View model](api-host.md#view-model) | `<block>.view` | The block view is malformed; the last good view stays |
| `spawn must return a spec table or nil, got <type>` | `spawn` | The filter returned a string, number or boolean; its result is ignored |
| `a route returns a decision table or nil` | `route.open`, `route.link` | |
| `a route decision sets block, url, path or handled = true` | `route.open`, `route.link` | A table with none of the decision keys |
| ``a route decision has an unknown how `<how>` `` | `route.open`, `route.link` | `how` is not `default`, `beside`, `below`, `split`, `tab`, `replace` or `preview` |
| `a title formatter returns a string or nil` | `tab_title`, `window_title` | |
| `a status formatter returns a list of segments or nil` | `status` | |

A route handler that fails counts as declining; the next handler, or Tern's
own open, runs.

## API errors

Raised by `tern` members; the member pages give each in context.

| Message | Raised by | Cause |
| --- | --- | --- |
| `cannot encode a <type> as JSON`, `cannot encode a <type> key as JSON`, `cannot encode <n> as JSON`, `cannot encode tables nested this deep (or cyclic) as JSON` | `tern.json.encode`, `tern.kv.set`, anything that sends Lua values (views, `save`, `spawn`) | Functions, userdata, non-string keys, NaN or infinity, cycles or more than 128 levels |
| `tern.json.decode: <parser message>` | `tern.json.decode` | Invalid JSON |
| `tern.kv.set: <io error>` | `tern.kv.set` | `kv.json` cannot be written |
| `tern.fs.<verb> <path>: <io error>` | `tern.fs.read`, `write`, `list`, `mkdir`, `remove` | The operation failed |
| `tern.process.run: argv is empty` | `tern.process.run` | |
| `tern.process.run <program>: <io error>` | `tern.process.run` | The program could not start (not found, not executable) |
| `tern.process.run(argv, opts?, cb): bad arguments` | `tern.process.run` | The arguments after `argv` are not `cb` or `opts, cb` |
| `tern.process is not available on iOS` | `tern.process.run` | iOS forbids starting processes; branch on `tern.runtime.os` |
| `tern.fetch(url, opts?, cb): bad arguments` | `tern.fetch` | The arguments are not `(url, cb)`, `(url, opts, cb)` or `(url, nil, cb)` |
| `tern.fetch <url>: not an absolute http or https URL` | `tern.fetch` | Another scheme, a relative URL, or no host |
| `tern.fetch <url>: <reason>` | `tern.fetch` | The URL, method, a header name or a header value is malformed; `<reason>` comes from the HTTP library (`invalid uri character`, `invalid HTTP method`, `invalid HTTP header name`, `failed to parse header value`). Network failures never raise; they arrive in `result.error` |
| `tern.ui.<builder>: <argument>: <problem>` | `tern.ui.*` | See [Argument conversion](ui.md#argument-conversion) |
| `tern.parse.<f>: lines…: expected …` | `tern.parse.*` | See [Parsers](ui.md#parsers) |
| `cx:frame: ops must be a list` | Block `cx:frame` | |
| `no program runs in that pane` | Window `cx:run` | The pane has no running terminal |
| ``unknown command `<id>` `` | Window `cx:command` | Not a built-in command id |
| ``unknown toast level `<level>` (success, info or error)`` | Window `cx:toast` | Host `cx:toast` accepts any level instead |
| ``unknown how `<how>` `` | Window `cx:open`, `cx:new_block` | |
| ``unknown direction `<dir>` (right, down, left or up)`` | `cx.layout` methods | |
| `tern.chrome.refresh: not from a formatter` | `tern.chrome.refresh` | Called while a chrome formatter runs; call it from a timer, event or command |

## Blocks that cannot start

| Message | Cause | Fix |
| --- | --- | --- |
| Toast "Could not start the block" / `no block type <kind> on this host` | A block pane's host has no Ready plugin defining its type: the session daemon (or, without one, the window) was asked to start it. The pane shows the same "Could not start the block" card with Retry | Install or enable the plugin on the host that runs the pane; check its status |
| Toast "Could not open the block" / `No plugin on <host> defines block type <kind>` | A `tern.route.open` or `tern.route.link` decision named a kind no Ready plugin on the file's (or link pane's) host defines; nothing opened | Install the plugin on that host, or return the decision only for hosts that have it (`req.host`) |
| `no block type <kind> on this host` printed in the pane, exit status 1 | After a reload the block's plugin or type is gone | Restore the plugin, then start the block again |
| ``could not start block `<kind>` ``, the second value `cx.layout:tab` returns (not raised, not toasted) | A leaf of the workspace names a kind no Ready plugin on the host defines. The first leaf: no tab opens (the id is `nil`). A later one: it and its subtree are left out, the rest is built and named. Several are comma-separated | Install the plugin on that host, or fix the kind |

Block types live on the host that runs the pane: a remote host needs the
plugin installed there. iOS runs no host halves, so plugin blocks run only on
the hosts an iOS device connects to.

## Log-only messages

These go to the log at warn level and never toast:

| Message | Meaning |
| --- | --- |
| `plugin spawn filter took over 50 ms; skipped` | A plugin's `spawn` answer came too late and was discarded |
| `plugin keeps re-rendering; requests dropped` | `cx` requests were still queued after 8 rounds (a `view` that calls `cx:render`) |
| `plugin hook exceeded its budget; disabled until reload` | A budget trip (also toasted, once) |
| `plugin style sheet has errors` | CSS in `styles` or `tern.css` didn't parse cleanly; valid rules still apply |
| `plugin worker didn't retire in time` | A reload waited 3 s for an old worker |
| `cannot create the plugin data directory` | `<state>/plugin-data/<id>` could not be made; `tern.kv` writes will fail |
| `cannot hand a process result to Lua` | A finished process's output could not become a Lua table |

## Command line

`tern plugin` prints errors as `tern plugin: <message>` on standard error.
Usage errors exit 2 and print the usage; the rest exit 1, or 124 when the
daemon doesn't answer in time.

| Message | Verb | Cause |
| --- | --- | --- |
| `plugin takes other arguments` | any | Missing verb, unknown verb, or wrong number of words |
| `unknown flag --<name>` | any | |
| `--window takes a value` | any | |
| `no daemon running` | `reload` | Start Tern, or use `list` |
| `the session daemon did not answer` | `reload` | Exit 124 after 60 s; a host entry may be slow to load |
| `no config directory for plugins` | `dir`, `install`, `remove`, `link`, `unlink` | The machine has no configuration directory |
| `<id> is already installed (<dir>); --force replaces it` | `install` | |
| `<id> is linked (<dir>); use unlink first` | `install` | With or without `--force` |
| `<id> is already installed (<dir>)` | `link` | An installed copy has the id |
| `<id> is linked; use unlink` | `remove` | |
| `<id> is installed, not linked; use remove` | `unlink` | |
| `no plugin <id> in <dir>` | `remove`, `unlink` | |
| `no plugin id <id>` | `remove`, `unlink` | Empty, starts with `.`, or contains a path separator |
| `no directory <path>: <io error>`, `<path> is not a directory` | `install`, `link` | |
| `<dir> is not a plugin: <why>` | `install`, `link` | `no plugin.toml` or any [folder problem](#plugins-folder-problems) the loader reports (`missing entry <path>`, `cannot read style <path>: <io error>`, …) |
| `<dir> is not UTF-8` | `link` | |
| `installing from git needs git` | `install` | |
| `git clone <url> failed: <git's message>` | `install` | |

After a successful change, these may follow on the output (standard error
with `--json`) without changing the exit code: `no daemon running; changes
apply at next start`, `the daemon did not reload its plugins: <error>`, and
the `list` lines of Failed plugins and problems. See
[Command Line](cli.md).

## Related pages

- [Debugging](../guides/debugging.md) for reading logs and reproducing
  failures.
- [Runtime, Budgets, and JIT](../concepts/runtime.md#failures-and-toasts).
- [Limits](limits.md).
