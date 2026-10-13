# Shared API

These members exist in both the host and the window context. They behave the
same in both, except where a note says which context's machine, thread or
`cx` is involved. The view builders (`tern.ui`) and parsers (`tern.parse`)
are shared too and have their own page, [UI Builders](ui.md).

## Identity

### `tern.context`

```lua
tern.context: "host" | "window"
```

Which half this VM runs: `"host"` for the `host` entry, `"window"` for the
`window` entry. Use it in modules both entries `require`.

### `tern.plugin`

```lua
tern.plugin: PluginInfo

type PluginInfo = {
	id: string,
	name: string,
	dir: string,
	data: string,
}
```

| Field | Value |
| --- | --- |
| `id` | Manifest `id` |
| `name` | Manifest `name` |
| `dir` | Absolute path of the package directory (the link target for a linked package) |
| `data` | Absolute path of the plugin's data directory, `<state>/plugin-data/<id>`, created before the entry runs |

The data directory belongs to the plugin; `tern.kv` keeps `kv.json` there and
processes started with `tern.process.run` see it as `TERN_PLUGIN_DATA`.

### `tern.runtime`

```lua
tern.runtime: RuntimeInfo

type RuntimeInfo = {
	os: string,
	jit: boolean,
}
```

| Field | Value |
| --- | --- |
| `os` | `"macos"`, `"linux"`, `"windows"` or `"ios"` |
| `jit` | `true` when Luau native code generation is active for this VM; always `false` on iOS |

See [Runtime, Budgets, and JIT](../concepts/runtime.md#jit).

## Logging

### `tern.log`

```lua
tern.log.debug: (...any) -> ()
tern.log.info: (...any) -> ()
tern.log.warn: (...any) -> ()
tern.log.error: (...any) -> ()
```

Writes one record to Tern's log at that level, target `tern::plugin`, with
field `plugin` set to the plugin id. Arguments are converted with `tostring`
and joined with tabs, as `print` does. Global `print` is `tern.log.info`.

```lua
tern.log.warn("cache miss", key, #entries)
```

Nothing is returned and nothing raises. Tern's default log filter is
`warn,stencil=info`, so only `warn` and `error` records from `tern::plugin`
are kept; set `STENCIL_LOG=warn,stencil=info,tern::plugin=debug` to keep
`info` (and `print`) and `debug`. See [Debugging](../guides/debugging.md) for
where the log is.

## JSON

The same conversion carries view trees, block state, `kv` values and events,
so its rules apply wherever a Lua value becomes JSON.

| Lua | JSON |
| --- | --- |
| `nil`, `tern.json.null` | `null` |
| boolean | boolean |
| integer, or a float with no fraction within ±2^53 | integer |
| other finite float | number |
| string | string (invalid UTF-8 replaced) |
| table with keys exactly `1..n`, `n > 0` | array |
| empty table tagged by `tern.json.array` or decoded from `[]` | `[]` |
| empty untagged table | `{}` |
| any other table | object, keys sorted; number keys become their text |

Functions, userdata other than `tern.json.null`, threads, NaN and infinities
cannot be encoded; nesting deeper than 128 tables (which a cycle reaches) is
refused.

### `tern.json.encode`

```lua
tern.json.encode: (value: any, pretty: boolean?) -> string
```

| Parameter | Type | Meaning |
| --- | --- | --- |
| `value` | `any` | Value to encode |
| `pretty` | `boolean?` | Indent the output (default `false`) |

Returns the JSON text.

Raises `cannot encode a <type> as JSON`, `cannot encode a <type> key as JSON`,
`cannot encode <n> as JSON` (non-finite number) or `cannot encode tables
nested this deep (or cyclic) as JSON`.

### `tern.json.decode`

```lua
tern.json.decode: (text: string) -> any
```

Decodes `text`. Arrays come back as tables tagged as arrays (so they
re-encode as arrays even when empty); `null` inside an array becomes
`tern.json.null`; object members whose value is `null` are dropped. Integers
come back as integers.

Raises `tern.json.decode: <parser message>` for invalid JSON.

```lua
local cfg = tern.json.decode(tern.fs.read("config.json"))
local port = cfg.port or 8080
```

### `tern.json.array`

```lua
tern.json.array: (<T>(t: T) -> T) & (() -> { any })
```

Tags `t` (or a new empty table) as a JSON array and returns it, so an empty
one encodes as `[]` rather than `{}`. A non-empty table with keys `1..n`
encodes as an array with or without the tag.

```lua
tern.json.encode({ items = tern.json.array() })  --> {"items":[]}
```

### `tern.json.null`

```lua
tern.json.null: JsonNull
```

A value that stands for JSON `null` where Lua `nil` cannot (array items,
explicit nulls in objects).

## Time and environment

### `tern.now`

```lua
tern.now: () -> number
```

Milliseconds on a monotonic clock, with a fractional part. The origin is the
first call in the process, so only differences mean anything.

### `tern.getenv`

```lua
tern.getenv: (name: string) -> string?
```

The value of environment variable `name` in this context's process, or `nil`
when it is unset or not valid Unicode. The host context reads the session
daemon's environment (or the window's, when no daemon runs); the window
context reads the Tern app's.

### `tern.timer`

```lua
tern.timer: (ms: number, fn: (cx: WindowCx?) -> ()) -> TimerHandle

declare extern type TimerHandle with
	function cancel(self): ()
end
```

| Parameter | Type | Meaning |
| --- | --- | --- |
| `ms` | `number` | Delay in milliseconds; negative counts as 0 |
| `fn` | function | Called once when the delay has passed |

Returns a handle; `handle:cancel()` removes the timer and does nothing once
it fired or the VM is gone.

The callback runs on the thread that owns the VM, never concurrently with
another handler of the same plugin and context, under the context's normal
budget, as hook `timer`. In the window context it receives a fresh window
`cx`; in the host context it receives nothing. A failing host timer is
toasted to every window.

Raises `the plugin is gone` when called after the VM was dropped (from a
callback that outlived a reload).

```lua
local function tick(cx)
	cx:toast("info", "Still here")
	tern.timer(60000, tick)
end
tern.timer(60000, tick)
```

Timers do not repeat; reschedule from the callback. A reload drops every
pending timer with its VM.

### Awaitables and `tern.sleep`

```lua
type Awaitable<T> = {
	kind: string,
	id: number,
	next: (self: Awaitable<T>, fn: (result: T?, err: string?, cx: WindowCx?) -> ()) -> (),
}
tern.sleep: (ms: number) -> Awaitable<nil>
```

An awaitable holds an async operation's VM-local identity and result.
`a:next(fn)` queues `fn(result, err, cx?)` on the VM's owning thread as
hook `await`, under the normal callback budget. On success `err` is nil;
on failure `result` is nil and `err` is a string. Window callbacks receive
a fresh `cx`. Callbacks registered after completion are still queued,
never called inline. Multiple callbacks may observe the same result.

`tern.sleep(ms)` resolves with nil after finite, nonnegative milliseconds.
The owner schedules it alongside ordinary timers; it does not block the VM.

```lua
tern.sleep(100):next(function(_, err, cx)
	if err then error(err) end
	cx:toast("info", "Finished waiting")
end)
```

Carly's `lua` calls use `await(a)` instead of callbacks. Her VM captures `print`,
has a 64 MiB memory limit and exposes `loadstring`. `require("name")` loads a saved
snippet; use `tern.fs.read` and `loadstring` for source from any path. Her
environment, filesystem, process and network APIs have ordinary window-plugin
capabilities, including in async callbacks. Relative filesystem paths resolve
against her VM's working directory; plugin registration APIs remain unavailable.
Normal argument validation, operation failures, deadlines and resource budgets
still apply. Ordinary plugin globals and budgets are unchanged.

## Storage

### `tern.kv`

```lua
tern.kv.get: (key: string) -> any
tern.kv.set: (key: string, value: any) -> ()
```

A persistent map of JSON values in `<data>/kv.json`.

| Function | Behavior |
| --- | --- |
| `get(key)` | The value stored under `key`, converted from JSON, or `nil` |
| `set(key, value)` | Stores `value`; `nil` (or `tern.json.null`) deletes the key. The whole file is rewritten atomically (temp file and rename), pretty-printed |

A missing store is an empty map. Both `get` and `set` raise when the store
cannot be read or contains invalid JSON; these failures do not silently
return `nil` or overwrite it. The last successfully loaded cache is retained,
but is not served as a successful fallback: the next call retries loading.
`set` also raises the JSON conversion errors listed under [JSON](#json), and
`tern.kv.set: <io error>` when the file cannot be written.

Both halves and every window's window half share the one file. Each VM
keeps the map in memory and reads `kv.json` again when its modification
time or length changed, so `get` sees other VMs' writes and `set` changes
the current map instead of writing back a stale copy. Simultaneous sets
from two VMs race; the last rename wins.

```lua
local runs = (tern.kv.get("runs") or 0) + 1
tern.kv.set("runs", runs)
```

### `tern.fs`

```lua
tern.fs.read: (path: string, max_bytes: number?) -> string
tern.fs.write: (path: string, text: string) -> ()
tern.fs.list: (path: string) -> { string }
tern.fs.exists: (path: string) -> boolean
tern.fs.mkdir: (path: string) -> ()
tern.fs.remove: (path: string) -> ()
```

Synchronous file access on the machine this context runs on. A relative path
resolves against the plugin directory (`tern.plugin.dir`), not a pane's
working directory; `~` is not expanded.

| Function | Behavior | Raises |
| --- | --- | --- |
| `read(path, max_bytes?)` | Raw bytes (not checked for UTF-8); an optional nonnegative integer byte bound requires a regular, non-symlink file | `tern.fs.read <path>: <error>` |
| `write(path, text)` | Creates or truncates the file and writes `text`; parent directories must exist | `tern.fs.write <path>: <error>` |
| `list(path)` | Entry names of a directory, sorted, as an array | `tern.fs.list <path>: <error>` |
| `exists(path)` | Whether the path exists (follows symlinks) | never |
| `mkdir(path)` | Creates the directory and missing parents; an existing directory is fine | `tern.fs.mkdir <path>: <error>` |
| `remove(path)` | Removes a file or symlink, or a directory with everything in it | `tern.fs.remove <path>: <error>` |

The path in the error is the resolved absolute path.

Use `tern.fs.read(path, 64 * 1024)` for untrusted small files. With a bound,
directories, FIFOs, devices, and final-component symlinks/reparse points
are rejected. The opened handle is checked, not just an earlier path stat:
replacement races cannot redirect a read into a blocking FIFO or device.
An oversized file is rejected before its contents are allocated or read;
growth after the check is detected with at most `max_bytes` buffered bytes
and a one-byte probe. This is implemented on both Unix and Windows.
Symlinks in ancestor directories are still resolved normally. Without the
bound, `read` retains ordinary filesystem read semantics, including following
symlinks and unbounded allocation. A bound is not a wall-clock deadline:
regular-file reads on slow disks or network filesystems can still block.

Every call blocks the context's thread. In the window context that is the UI
thread under a 50 ms budget: keep reads small, and move large or slow work to
`tern.process.run`.

```lua
local notes = tern.plugin.data .. "/notes"
tern.fs.mkdir(notes)
tern.fs.write(notes .. "/today.md", "# Today\n")
```

## Processes

### `tern.process.run`

```lua
tern.process.run: ((argv: { string }, opts: ProcessOptions?, cb: (result: ProcessResult, cx: WindowCx?) -> ()) -> ())
	& ((argv: { string }, cb: (result: ProcessResult, cx: WindowCx?) -> ()) -> ())
	& ((argv: { string }, opts: ProcessOptions?) -> Awaitable<ProcessResult>)

type ProcessOptions = {
	cwd: string?,
	env: { [string]: string }?,
	stdin: string?,
	timeout_ms: number?,
}

type ProcessResult = {
	status: number,
	stdout: string,
	stderr: string,
	timed_out: boolean,
}
```

Starts `argv[1]` with arguments `argv[2..]` directly (no shell), on this
context's machine, and returns at once. When the process exits and its
output is read, `cb` runs on the VM's thread as hook `process`.

Without `cb`, `run(argv, opts?)` returns an `Awaitable<ProcessResult>`.
Use `:next(function(result, err, cx) ... end)` in a plugin or
`await(tern.process.run(argv, opts))` in Carly's `lua` tool. Spawn failures
still raise at the call; process failures are represented by the result's
status, not an await error.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `argv` | `{ string }` | Program and arguments; the program is looked up on `PATH` |
| `opts` | `ProcessOptions?` | May be omitted entirely: `run(argv, cb)` |
| `cb` | function | Receives the result; in the window context also a fresh window `cx` |

| Option | Default | Meaning |
| --- | --- | --- |
| `cwd` | the plugin directory | Working directory; a relative path resolves against the plugin directory |
| `env` | none | Variables added to the inherited environment |
| `stdin` | empty | Bytes written to stdin, which then closes |
| `timeout_ms` | none | Kills the process after this many milliseconds (values ≤ 0 mean none) |

| Result field | Meaning |
| --- | --- |
| `status` | Exit code; `-1` when killed by the timeout or ended by a signal |
| `stdout` | Captured standard output, at most 16 MiB (the rest is read and discarded) |
| `stderr` | Captured standard error, at most 16 MiB |
| `timed_out` | `true` when `timeout_ms` elapsed and the process was killed |

Every process also gets `TERN_PLUGIN_DATA` set to `tern.plugin.data`.

Raises at the call:

- `tern.process.run(argv, opts?, cb): bad arguments` when the arguments are
  not `(argv, cb)`, `(argv, opts, cb)` or `(argv, nil, cb)`;
- `tern.process.run: argv is empty`;
- `tern.process.run <program>: <error>` when the program cannot be started
  (not found, not executable, bad `cwd`);
- `tern.process is not available on iOS` on iOS, in every case.

A non-zero exit is not an error: check `status`. Pending callbacks are
dropped when the VM is (a reload); the process itself keeps running to its
end. A failing host callback is toasted to every window.

```lua
local repo = (tern.getenv("HOME") or "") .. "/src/project"
tern.process.run({ "git", "rev-parse", "--abbrev-ref", "HEAD" }, { cwd = repo, timeout_ms = 2000 }, function(r, cx)
	if r.status == 0 then
		cx:toast("info", "On branch " .. r.stdout:gsub("%s+$", ""))
	end
end)
```

(This sample is a window entry; in a host entry `cx` is `nil`.)

## Network

### `tern.fetch`

```lua
tern.fetch: ((url: string, opts: FetchOptions?, cb: (result: FetchResult, cx: WindowCx?) -> ()) -> ())
	& ((url: string, cb: (result: FetchResult, cx: WindowCx?) -> ()) -> ())
	& ((url: string, opts: FetchOptions?) -> Awaitable<FetchResult>)

type FetchOptions = {
	method: string?,
	headers: { [string]: string }?,
	body: string?,
	timeout_ms: number?,
}

type FetchResult = {
	status: number,
	headers: { [string]: string },
	body: string,
	error: string?,
	timed_out: boolean,
}
```

Sends one HTTP/1.1 request from this context's machine, on its own thread,
and returns at once (nothing with a callback, an awaitable without one).
In the host context that is the session
daemon's machine, so a remote host's plugins fetch from that host; in the
window context it is the machine showing the window. When the whole response
has been read, or the request failed, `cb` runs on the VM's thread as hook
`fetch`. Unlike `tern.process.run`, it works on iOS.

Without `cb`, `fetch(url, opts?)` returns an `Awaitable<FetchResult>`.
Network errors still set `result.error`; malformed arguments still raise
at the call. The callback forms retain their existing signatures and hooks.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `url` | `string` | An absolute `http://` or `https://` URL, already percent-encoded (nothing is encoded for you) |
| `opts` | `FetchOptions?` | May be omitted entirely: `fetch(url, cb)` |
| `cb` | function | Receives the result; in the window context also a fresh window `cx` |

| Option | Default | Meaning |
| --- | --- | --- |
| `method` | `"GET"` | Any HTTP method token, case-insensitive (sent uppercase), so `"propfind"` works |
| `headers` | none | Request headers, name → value; `User-Agent` is `Tern` unless set here |
| `body` | none | Request body bytes, sent with `Content-Length`. Without `body` no body is sent; `""` sends an empty one |
| `timeout_ms` | `30000` | The whole exchange (connecting, TLS, sending, response headers and body, every redirect) must finish within it, or the request fails with `timed_out = true`. Values ≤ 0 mean the default; `math.huge` means no practical limit |

| Result field | Meaning |
| --- | --- |
| `status` | The HTTP status. Every status is a response: 404 or 500 is not an error. `0` when `error` is set |
| `headers` | Response headers by lowercase name; a repeated header's values joined with `", "`. Empty when `error` is set |
| `body` | Response body bytes (not checked for UTF-8), at most 16 MiB. `""` when `error` is set |
| `error` | `nil` when a whole response arrived; otherwise why not (no such host, connection refused, TLS failure, timeout, too many redirects, a body over 16 MiB, …) |
| `timed_out` | `true` when `timeout_ms` (or the 30 s default) ended the request |

The `error` text comes from the HTTP client (for example `timeout: global`,
`too many redirects`, `io: Connection refused (os error 61)`); show it, don't
parse it.

Raises at the call (network failures never raise; they arrive in
`result.error`):

- `tern.fetch(url, opts?, cb): bad arguments` when the arguments are not
  `(url, cb)`, `(url, opts, cb)` or `(url, nil, cb)`;
- `tern.fetch <url>: not an absolute http or https URL` for another scheme,
  a relative URL or no host;
- `tern.fetch <url>: <reason>` when the URL, method, a header name or a
  header value is malformed; `<reason>` comes from the HTTP library (for
  example `invalid uri character`, `invalid HTTP method`,
  `invalid HTTP header name`, `failed to parse header value`).

Redirects are followed, up to 10 (more fails with `error`). An
`Authorization` header is not sent again after a redirect. A 307 or 308
redirect of a request with a body fails with `error` instead of resending
the body.

HTTPS certificates are checked against the operating system's trust store.
The context process's proxy variables (`ALL_PROXY`, `HTTPS_PROXY`,
`HTTP_PROXY`, `NO_PROXY`, either case) are honored. No compression is
requested and no cookies are kept between requests. Connections are kept
alive and reused across one VM's requests. There is no cap on the number of
requests in flight.

Pending callbacks are dropped when the VM is (a reload); the request itself
runs to its end. A failing host callback is toasted to every window.

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

(This sample is a window entry; in a host entry `cx` is `nil`.)

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

## Related pages

- [UI Builders](ui.md) for `tern.ui` and `tern.parse`.
- [Files, Processes, and Storage](../guides/io.md) for patterns built on
  these members, `tern.fetch` included.
- [Limits](limits.md) for every cap mentioned here.
