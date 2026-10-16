# Runtime, Budgets, and JIT

Every plugin half runs in its own Luau VM: sandboxed, limited to 256 MiB,
and interrupted when a call runs past its time budget. A call that fails
costs only that call; a call that runs out of time also disables its hook
until the next reload. This page describes the VM, the budgets and what
happens when they trip, how failures are reported and logged, and when Luau
runs as native code.

## The VM

Each VM is a Luau state with Luau's standard library, put in sandbox mode
before any plugin code runs:

| Available | Not available |
| --- | --- |
| Luau's base functions (`pcall`, `error`, `pairs`, `setmetatable`, `typeof`, `loadstring`, …) | `io`: Luau has no I/O library |
| `string`, `table`, `math`, `coroutine`, `utf8`, `bit32`, `buffer`, `vector`, `integer` | Luau's `os` beyond `clock`, `date`, `difftime` and `time` (no `os.execute`, `os.getenv`, `os.remove`, `os.exit`) |
| Luau's `debug`, which has only `debug.info` and `debug.traceback` | |
| `os.clock`, `os.date`, `os.difftime`, `os.time` | `package`, `dofile`, `loadfile` |
| `require`, confined to the plugin ([Modules](#modules)) | `collectgarbage` options other than `"count"` |
| `print`, which is `tern.log.info` | Changing the built-in libraries: they are read-only (`string.upper = nil` raises) |
| The global `tern` ([API Reference](../reference/api.md)) | |

Globals a plugin defines are ordinary: they live in a writable layer over
the read-only libraries and are shared by the entry and every module it
loads, within that one VM.

Files, processes, the environment and the network are reached only through
`tern` (`tern.fs`, `tern.process`, `tern.fetch`, `tern.getenv`); there is no
other way out of the VM. That is a boundary for robustness, not a security
boundary: those `tern` members can reach anything the user can. See
[Trust and Security](security.md).

## Modules

`require` takes a string. `"tern"` returns the `tern` table, the same one
installed as the global. Anything else uses Luau's require-by-string,
resolved relative to the file that calls `require` and confined to the
plugin directory:

- `./name` and `../name` resolve to `name.luau`, `name.lua`,
  `name/init.luau` or `name/init.lua`; more than one match is an error.
- A path that would leave the plugin directory fails as not found.
- `.luaurc` files and `@alias` paths are not read.
- A module runs once per VM; later `require`s of the same file return its
  cached result.

Chunks are named after their absolute path, so error messages and
tracebacks name the file and line.

```lua
-- host.luau
local pods = require("./lib/pods")

-- lib/pods.luau
local M = {}

function M.parse(text: string): { string }
	local out = {}
	for line in string.gmatch(text, "[^\n]+") do
		table.insert(out, line)
	end
	return out
end

return M
```

luau-lsp does not resolve `require("tern")`; code you type-check should use
the global `tern`. See [API Reference](../reference/api.md#types-for-luau-lsp).

## Memory

Each VM may allocate at most 256 MiB. An allocation past the limit raises a
Luau memory error in the call that made it. It is an ordinary error: the call
fails and is reported like any other, `pcall` can catch it, and the hook stays
enabled. Lua state a host half keeps for blocks and lens captures counts
against its VM's limit, which is one reason a worker keeps state for only the
latest 256 lens captures.

## Budgets

Every call into Lua runs under a time budget that depends on where it runs:

| Call | Budget | Why |
| --- | --- | --- |
| Host: every call, including running `host.luau` | 2 s | A slow worker stalls only its own plugin |
| Window: chrome formatters (`tab_title`, `window_title`, `status`) and `available` | 4 ms | They run while the window builds a frame |
| Window: every other call, including running `window.luau` | 50 ms | It runs on the UI thread; the window does nothing else meanwhile |
| Daemon waiting for a `spawn` filter | 50 ms per plugin | The shell is waiting to start |

The `spawn` wait is not a VM budget: the filter itself runs on the worker
under the 2 s host budget, but the daemon stops waiting for that plugin's
answer after 50 ms and starts the shell with the spec as it stood before
that plugin (logged as `plugin spawn filter took over 50 ms; skipped`). See
[Host Hooks and the Spawn Filter](../guides/hooks.md).

When a call is made from inside another call in the same VM, the inner call
keeps the outer call's deadline if it is earlier.

Budgets are enforced through Luau's interrupt, which runs at function calls
and loop iterations. A single long native operation (a large `tern.fs.read`,
a huge `string.rep`) completes before the next check; the budget catches the
Lua around it, not the operation itself.

Budgets catch accidents: an infinite loop, a parse that grew with its input.
Long work belongs in `tern.process.run`, or spread across `tern.timer`
callbacks, never in a loop on the UI thread.

## A tripped budget

A call that runs past its deadline raises `tern: <hook> exceeded <n> ms`.
From that moment every interrupt check in the call raises again until the
call returns, so a `pcall` inside the handler cannot catch the error and
carry on. When the call returns, its hook is disabled in that VM until the
next reload: later calls of that hook are skipped without running and
without a toast. A host half logs each skipped call at debug level
(`disabled plugin hook skipped`); a window half logs each one at warn level
as `plugin handler failed`, with the error
`tern: <hook> is disabled after exceeding its budget`.

The hook is the unit that is disabled:

| Context | Hook names |
| --- | --- |
| Host | `load` (the entry); `<block>.init`, `<block>.view`, `<block>.title`, `<block>.key`, `<block>.event`, `<block>.resize`, `<block>.save`; `<lens>.open`, `<lens>.line`, `<lens>.finish`, `<lens>.view`, `<lens>.event`; each `tern.on` event name (`command_started`, `cwd`, …) and `spawn`; `timer`; `process`; `fetch` |
| Window | `load`; `command <id>`; `bind <n>`; `override <command>`; `available plugin.<plugin>.<id>`; `route.open`; `route.link`; `tab_title`; `window_title`; `status`; each `tern.on` event name (`window_start`, `focus`, …); `timer`; `process`; `fetch` |

So a `view` that trips stops rendering every block of that type, and one
slow timer callback disables all of the plugin's timer callbacks in that VM.
Hooks are per VM: a trip in one window does not disable the hook in another
window. A reload creates fresh VMs and re-enables everything.

## Failures and toasts

A handler that raises loses only that call: the plugin keeps running, its
state is whatever the handler left before raising, and the failure is logged
and shown:

| Failure | Toast (first line / second line) | Shown in |
| --- | --- | --- |
| A handler raised, returned a value of the wrong shape, or tripped its budget | "Plugin *name*: *hook* failed" / the error's first line | Host: the windows showing the pane concerned, or every window of the host for timers, process and fetch callbacks and the `spawn` filter. Window: that window. |
| A window entry failed to load | "Plugin *name* failed to load" / the error's first line | That window, unless the same failures were already reported by the previous load |
| A host's catalog has problems or Failed plugins | "1 plugin has problems" or "*N* plugins have problems" / the first error | Every window attached to that host, when its catalog changes |
| A block's `init` raised | The handler toast, and the block ends with exit status 1 and the error printed in the pane | Windows showing the block |

A tripped budget toasts once, when it trips; skipped calls of the disabled
hook do not toast again. See [Errors](../reference/errors.md) for the error
messages themselves.

## Logs

`tern.log.debug`, `info`, `warn` and `error` join their arguments with tabs
(through `tostring`) and log one line through Tern's tracing at that level,
with target `tern::plugin` and the field `plugin=<id>`. `print` is
`tern.log.info`.

Lines are written to the log file of the process the half runs in:

| Platform | Log folder |
| --- | --- |
| macOS, iOS | `~/Library/Logs/Tern` (on iOS, inside the app's container) |
| Linux | `$XDG_STATE_HOME/tern/logs` (`~/.local/state/tern/logs`) |
| Windows | `%LOCALAPPDATA%\Tern\Logs` |
| Any | `$STENCIL_LOG_DIR`, when set |

Host halves log to `tern-daemon.log` (or the window's log when the window
runs its panes without a daemon); window halves log to the window's
`tern.log`. A file moves to `<name>.1.log` at 16 MiB, and `<name>.2.log` is
the oldest kept. Warnings and errors also go to standard error.

The default filter is `warn,stencil=info`: Tern's own modules (`stencil_*`)
from info, everything else from warn. `tern::plugin` is not a `stencil`
target, so by default only `tern.log.warn` and `tern.log.error` reach the
file; `print`, `tern.log.info` and `tern.log.debug` are dropped. To keep
them, start the process with `STENCIL_LOG` set; it replaces the filter for
both the file and standard error:

```sh
STENCIL_LOG=warn,stencil=info,tern::plugin=debug
```

The runtime's own reports are under Tern's targets and reach the file by
default, at warn level: `plugin handler failed` (with `plugin`, `hook` and the
error with its traceback), `plugin hook exceeded its budget; disabled until
reload`, `plugin failed to load`, `plugin window entry failed to load`,
`not a usable plugin`, `plugin spawn filter took over 50 ms; skipped`,
`plugin keeps re-rendering; requests dropped`, `plugin bind left out` and
`plugin style sheet has errors`. See [Debugging](../guides/debugging.md).

## Timers, process and fetch callbacks

`tern.timer`, `tern.process.run` and `tern.fetch` callbacks never run on
another thread. When a timer comes due, a process ends or a request
finishes, the VM's owner is woken and runs the callback itself, on the same
thread as every other handler of that VM:

| Context | Runs on | Callback arguments | Budget |
| --- | --- | --- | --- |
| Host | The plugin's worker, between requests | `fn()`, `cb(result)` | 2 s |
| Window | The window's UI thread, after it renders | `fn(cx)`, `cb(result, cx)`, each with a fresh `cx` | 50 ms |

A process or request runs off the VM's thread; only its callback comes back.
Because callbacks are serialized with every other handler, Lua state needs
no locking, and a callback never interrupts a handler halfway. Due timers,
finished processes and finished requests run oldest first. Pending timers,
process and fetch callbacks end with their VM, at the next reload; a process
or request itself runs to its end. See
[Files, Processes, and Storage](../guides/io.md).

## JIT

On macOS, Linux and Windows, Tern builds Luau with its native code generator
and compiles every chunk it loads (entries and modules) to native code when
the CPU is one Luau's code generator supports; otherwise the interpreter runs
it. The macOS app is signed with the `com.apple.security.cs.allow-jit`
entitlement, which the hardened runtime requires before a process may create
executable memory. iOS forbids executable memory to apps, so Tern on iOS is
built without the code generator and always interprets. Plugin code is the
same in both modes; only speed differs.

`tern.runtime.jit` is `true` when native code generation is enabled for the
VM. The host's catalog carries `jit` too (true when any host half loaded
with it), which `tern plugin list --json` prints.

What `jit` can and cannot tell you:

| `jit` reports | `jit` does not report |
| --- | --- |
| The build includes Luau's code generator (false on iOS) | Whether a particular function was compiled to native code |
| The CPU is supported by the code generator, checked when the VM is created | Whether the operating system actually granted executable memory |
| | Anything about the other half or another host; each VM reports its own |

Use it for diagnostics, not to choose between code paths.

## Numbers and ids

Luau's `number` is a 64-bit float: integers are exact up to 2<sup>53</sup>.
Every number the `tern` API takes or returns is a `number`.
`tern.json.encode` writes integral numbers as JSON integers and other
numbers as floats; `tern.json.decode` reads JSON numbers as Luau numbers.
Luau's `integer` library (64-bit integers as a separate value type) is
loaded too, but nothing in `tern` produces those values.

Pane and tab ids are numbers. In the host half they are the daemon's own ids.
In the window half, a remote host's panes carry a host tag in high bits that
would not survive a double, so Tern moves the tag down (from bit 56 to bit
44) before handing the id to Lua and moves it back when Lua passes it in.
Treat ids as opaque: pass them back unchanged, do not do arithmetic on them,
and do not compare ids from one window with ids from another.

## Related pages

- [Limits](../reference/limits.md): every budget and size in one table.
- [Lifecycle and Reload](lifecycle.md): what a reload resets.
- [Debugging](../guides/debugging.md): finding a failing handler.
