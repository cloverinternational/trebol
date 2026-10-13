# Files, Processes, and Storage

Both halves share the same I/O API: synchronous file access, a small
key-value store, child processes and HTTP requests with callbacks, timers,
JSON, the environment and the log. Each call acts on the machine its
context runs on: the host half's on the machine whose panes it serves, the
window half's on the machine showing the window.

```lua
tern.process.run({ "git", "rev-parse", "--abbrev-ref", "HEAD" }, { cwd = "/srv/api" }, function(result, cx)
	if result.status == 0 and cx then
		cx:toast("info", "Branch", (string.gsub(result.stdout, "%s+$", "")))
	end
end)
```

## Which machine, which thread

| | Host half | Window half |
| --- | --- | --- |
| Machine | Where the panes run (the session daemon's machine, a remote host for its panes). | The machine showing the window, also for panes of remote hosts. |
| Thread | The plugin's worker thread. | The window's UI thread. |
| Budget per call | 2 s. | 50 ms (4 ms in chrome formatters and `available`). |
| Callback `cx` | None. | A fresh window `cx`. |

`tern.fs` and `tern.kv` are synchronous: the call returns when the disk does,
and the time counts against the calling handler's budget. In the window half
that time is the UI thread's. Reading a small config file is fine; walking a
tree, reading a large file or touching a network file system belongs in a
process, or in the host half.

## Files: `tern.fs`

| Function | Does |
| --- | --- |
| `tern.fs.read(path) -> string` | The file's bytes as a Lua string. |
| `tern.fs.write(path, text)` | Writes `text`, replacing the file (not atomically). |
| `tern.fs.list(path) -> {string}` | Entry names of a directory, sorted. |
| `tern.fs.exists(path) -> boolean` | Whether the path exists. Never raises. |
| `tern.fs.mkdir(path)` | Creates a directory and its parents. |
| `tern.fs.remove(path)` | Removes a file, a symbolic link itself, or a directory with everything in it. |

Relative paths resolve against the plugin's directory (`tern.plugin.dir`), so
`tern.fs.read("templates/row.txt")` reads a file shipped with the plugin.
Absolute paths go anywhere the user can. Failures raise with the verb and
path: `tern.fs.read /etc/nope: No such file or directory (os error 2)`.
Wrap calls that may fail in `pcall`.

Don't write into the plugin directory. Tern watches it and reloads the
plugin on every change there, and `tern plugin install --force` replaces it.
Write state to `tern.plugin.data` instead.

## Storage: `tern.kv`

`tern.kv.get(key)` and `tern.kv.set(key, value)` keep JSON values by string
key in `<data>/kv.json`, where `<data>` is `tern.plugin.data`
(`<state>/plugin-data/<id>/`, created at load). `set` with `nil` (or
`tern.json.null`) deletes the key.

```lua
local runs = (tern.kv.get("runs") or 0) + 1
tern.kv.set("runs", runs)
tern.kv.set("last", { line = "cargo test", status = 0 })
```

Every `set` rewrites the whole file through a temporary file and a rename, so
a reader never sees half a file. Values follow the [JSON
rules](#json-ternjson): no functions, no cycles, and an empty table stored
as `{}` comes back as an empty object unless it was tagged an array.

The file is the plugin's on its machine, and both halves of a plugin, and
the window halves of every window, use the same one. Each VM keeps the map
in memory and reads the file again whenever it changed on disk (its
modification time or length differs), so a `get` sees what any half last
set, and a `set` updates the current file rather than writing back a stale
copy. Two VMs setting at the same moment still race: the later rename wins.
The store is meant for small state: every `set` serializes all of it.

An absent file is an empty store. Read failures and invalid JSON raise an
error instead of returning missing keys or overwriting the file. A failed
reload preserves the last successful cache and retries on the next call.
Failed writes remove their temporary files.

## Processes: `tern.process.run`

```text
tern.process.run(argv, opts?, callback)
```

Runs a program off the calling thread and calls `callback(result, cx?)` on
the owning thread when it exits.

| Argument | Meaning |
| --- | --- |
| `argv` | The program and its arguments, `{program, arg, …}`. No shell: write `{"sh", "-c", line}` for pipes and globs. The program is looked up on the `PATH` of the context's process. |
| `opts.cwd` | Working directory. Relative paths resolve against the plugin directory, which is also the default. |
| `opts.env` | Variables added to the inherited environment. |
| `opts.stdin` | Text written to the process's stdin, which then closes. Without it, stdin closes at once. |
| `opts.timeout_ms` | Kills the process after this many milliseconds. |
| `callback` | Required. `fn(result, cx?)`. |

Every process also gets `TERN_PLUGIN_DATA`, the plugin's data directory.

The result:

| Field | Meaning |
| --- | --- |
| `status` | Exit code; `-1` when the process was killed (timeout) or ended by a signal. |
| `stdout` | Captured standard output, at most 16 MiB (the rest is read and dropped). |
| `stderr` | Captured standard error, at most 16 MiB. |
| `timed_out` | `true` when `timeout_ms` elapsed and the process was killed. |

A program that can't start raises at the call: `tern.process.run nope: No
such file or directory (os error 2)`. An empty `argv` raises too. Bad
argument shapes raise `tern.process.run(argv, opts?, cb): bad arguments`.

The callback runs on the context's own thread like any handler, with that
context's budget, as hook `process`: window callbacks get a fresh `cx` and
50 ms; host callbacks get no `cx` and 2 s. The callbacks of a VM that was
dropped by a reload never run.

On iOS there are no processes: `tern.process.run` raises `tern.process is not
available on iOS`. Check `tern.runtime.os` when a window half should also
work on iPad.

## Network: `tern.fetch`

```text
tern.fetch(url, opts?, callback)
```

Sends one HTTP request off the calling thread and calls
`callback(result, cx?)` on the owning thread when the whole response has
arrived or the request failed. Use it to talk to web APIs, webhooks and
local servers without starting `curl`. Unlike processes it works on iOS, so
a window half on iPad reaches the network this way.

The request leaves from the context's machine: a host half fetches from the
session daemon's machine (a remote host's plugins fetch from that host), a
window half from the machine showing the window.

```lua
tern.fetch("https://api.github.com/repos/neovim/neovim/releases/latest", {
	headers = { Accept = "application/vnd.github+json" },
	timeout_ms = 10000,
}, function(r, cx)
	if r.error then
		tern.log.warn("release check failed", r.error)
	elseif r.status == 200 then
		cx:toast("info", "Neovim " .. tern.json.decode(r.body).tag_name)
	end
end)
```

(A window entry; in a host entry `cx` is `nil`.) `opts` takes `method`
(default `"GET"`), `headers`, `body` and `timeout_ms` (default 30 s, for the
whole exchange):

```lua
tern.fetch("https://hooks.example.com/build", {
	method = "POST",
	headers = { ["Content-Type"] = "application/json" },
	body = tern.json.encode({ status = "done" }),
}, function(r)
	if r.error or r.status >= 300 then
		tern.log.warn("webhook failed", r.error or r.status)
	end
end)
```

Check the result in this order:

- `error` is set when no whole response arrived: no such host, connection
  refused, TLS failure, timeout, too many redirects, a body over 16 MiB.
  `status` is then `0`, `headers` empty and `body` `""`. Show the text;
  don't parse it.
- `timed_out` is `true` when the timeout ended the request (`error` is set
  too).
- Otherwise `status` is whatever the server answered. A 404 or 500 is a
  response, not an error: check it.

Network failures never raise. Only a malformed call does: bad argument
shapes, a URL that isn't absolute `http://` or `https://`, or a malformed
URL, method or header. The URL must already be percent-encoded. Redirects
are followed (up to 10), HTTPS certificates are checked against the
system's trust store, and the proxy variables of the context's process are
honored. See [Shared API](../reference/api-shared.md#network) for every
detail.

The callback runs like a process callback, as hook `fetch`: window callbacks
get a fresh `cx` and 50 ms; host callbacks get no `cx` and 2 s. The
callbacks of a VM that was dropped by a reload never run; the request itself
still runs to its end.

## Timers and time

`tern.timer(ms, fn)` calls `fn` once, `ms` milliseconds from now (negative
counts as 0), and returns a handle whose `cancel()` drops the timer; cancel
does nothing once it fired. In the window half `fn` receives a fresh `cx`.
For a repeating timer, re-arm from the callback:

```lua
local function tick(cx: WindowCx?)
	if cx then
		cx:toast("info", "Still here")
	end
	tern.timer(60000, tick)
end
tern.timer(60000, tick)
```

All of a plugin's timer callbacks run as hook `timer`, all its process
callbacks as hook `process`, and all its fetch callbacks as hook `fetch`.
A hook that runs over budget is disabled until the next reload, so one slow
timer callback stops every timer callback of that plugin. Timers die with
their VM on reload.

`tern.now()` returns monotonic milliseconds, fractional, counted from the
first call in the process. Use it for durations; it is no wall clock, and
host and window halves (separate processes, often) don't share an origin.

## JSON: `tern.json`

| Function | Does |
| --- | --- |
| `tern.json.encode(value, pretty?) -> string` | Encodes a Lua value; `pretty` indents. |
| `tern.json.decode(text) -> any` | Decodes JSON text; raises `tern.json.decode: …` on bad input. |
| `tern.json.array(t?) -> t` | Tags `t` (or a new table) as an array. |
| `tern.json.null` | A value that stands for JSON `null`. |

Encoding rules:

- A table whose keys are exactly `1..n` (n > 0) is an array; any other
  non-empty table is an object. Integer and number keys of an object become
  strings.
- An empty table encodes as `{}` unless it is array-tagged; then `[]`. Tag a
  list that may be empty with `tern.json.array`.
- Object keys come out sorted, so the same table always encodes the same
  text.
- Whole numbers within ±2^53 encode as integers. NaN and infinities,
  functions, userdata, keys other than strings and numbers, and nesting
  deeper than 128 (cycles) raise.
- `nil` can't sit in a table; use `tern.json.null` for a `null` array item or
  member.

Decoding rules: arrays come back array-tagged (re-encoding keeps `[]`), a
`null` array item is `tern.json.null`, and a `null` object member is left out
of the table.

```lua
local doc = tern.json.decode('{"tags": [], "owner": null}')
-- doc.tags is an empty, array-tagged table; doc.owner is nil
tern.json.encode(doc) --> {"tags":[]}
```

## Environment and logging

`tern.getenv(name)` reads the environment of the context's process: the
session daemon (or the window running panes without one) for the host half,
the Tern app for the window half. An app started from the Dock or a desktop
launcher may have a smaller environment than your shell; don't count on
`PATH` additions from shell profiles.

`tern.log.debug|info|warn|error(...)` writes to Tern's log with target
`tern::plugin` and the field `plugin = <id>`; the arguments go through
`tostring` and join with tabs. Global `print` is `tern.log.info`. The log
records only warnings and errors from this target unless `STENCIL_LOG` asks
for more; see [Debugging](debugging.md#logs).

## Never block the UI thread

A window handler runs on the UI thread, and the window doesn't draw until it
returns. The 50 ms budget stops a runaway handler, but a handler that takes
30 ms on every keystroke-adjacent event is already a visible stutter.

- Run programs with `tern.process.run`; never spin waiting for a file to
  appear.
- Keep `tern.fs` calls in window handlers to small local files; a path on a
  network mount can stall for seconds.
- Spread work over `tern.timer` callbacks, or move it to the host half, whose
  worker thread stalls only itself.
- Cache what formatters need: they run while the window draws, under 4 ms.

## See also

- [Runtime, Budgets, and JIT](../concepts/runtime.md): budgets and what a
  trip disables.
- [Shared API](../reference/api-shared.md): exact signatures.
- [Trust and Security](../concepts/security.md): what file and process access
  means for users.
- [Long-Running Commands](../examples/longrun.md): processes and timers in a
  complete plugin.
