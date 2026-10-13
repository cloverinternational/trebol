# Limits

Every fixed cap, timeout and default the plugin runtime applies, with its
value and what happens at the edge. None of them
are configurable. The concept pages explain why each exists; this page is the
lookup table.

## Packages and manifests

| Limit | Value | At the limit |
| --- | --- | --- |
| `plugin.toml` size | 64 KiB | Problem `plugin.toml is larger than 64 KiB` |
| Manifest schema | `1` | Problem `unsupported schema N` |
| Plugin, block and lens ids | `^[a-z][a-z0-9-]{0,31}$` (1–32 bytes) | Problem `invalid id …`, `invalid block id …`, `invalid lens id …` |
| Plugin `name` | 1–64 Unicode characters | Problem `name must be 1-64 characters` |
| Lens `match` patterns | At least 1 per lens | Problem `lens "x" needs at least one match pattern` |
| Total `styles` size | 256 KiB, after joining | Problem `styles are larger than 256 KiB` |
| Plugins per host | 64 valid packages, by id | Problem `too many plugins` for each past the 64th |
| `tern.command` ids, `tern.css` names | ASCII letters, digits, `_`, `-`; not empty; not `bind` / `styles` | Raises at the call |
| Default icon | `puzzle` | Used for an unknown or absent icon |

See [Manifest Reference](manifest.md).

## VMs and budgets

| Limit | Value | At the limit |
| --- | --- | --- |
| Memory per VM | 256 MiB | The allocating call raises a Luau memory error |
| Host call budget | 2 s per call, including running `host.luau` | Raises `tern: <hook> exceeded 2000 ms`; the hook is disabled in that VM until reload |
| Window call budget | 50 ms per call, including running `window.luau` | Raises `tern: <hook> exceeded 50 ms`; hook disabled |
| Chrome formatters and `available` | 4 ms per call | Raises `tern: <hook> exceeded 4 ms`; hook disabled |
| Nested calls | The outer call's deadline when earlier | |
| Disabled hook | Until the VM is replaced by a reload | Calls are skipped: `tern: <hook> is disabled after exceeding its budget`, logged at debug |

Budgets are checked at Luau's interrupt (function calls and loop
iterations): a single long native operation finishes before the check. See
[Runtime, Budgets, and JIT](../concepts/runtime.md#budgets).

## Host workers

| Limit | Value | At the limit |
| --- | --- | --- |
| `spawn` filter wait | 50 ms per plugin | That plugin's answer is discarded; logged `plugin spawn filter took over 50 ms; skipped` |
| Retiring worker on reload | 3 s to release its blocks | Logged `plugin worker didn't retire in time`; the reload goes on |
| `cx` request rounds after one call | 8 | Requests still queued (a `view` that calls `cx:render`) are dropped; logged `plugin keeps re-rendering; requests dropped` |
| Lens capture states per plugin | 256 | Finished captures are dropped first, least recently used first; a dropped capture is rebuilt from the block's output on its next event |
| Lens blocks whose plugin the host remembers | 4096 | The oldest are forgotten; their events are routed by re-claiming the block's command |
| `tern plugin reload` wait | 60 s | `the session daemon did not answer`, exit 124 |

## Lenses

| Limit | Value | At the limit |
| --- | --- | --- |
| View tick while the command runs | One `view` per 250 ms per block, and only after new lines | Lines accumulate until the next tick; `finish` always triggers a final `view` |
| Captured output per command | 16 MiB | The capture is abandoned; the output stays ordinary terminal text |
| A lens view waiting for its block | 5 s | A view that reaches a window before the window shows its lens block is retried until the block appears, then dropped after 5 s or when the pane goes |
| `tern.parse.json_tree` nodes | 5000 | The rest is summarized by an overflow line |

Tern's built-in lenses also stop at 5000 rows and add
`tern.ui.overflow(n)`'s line; plugin builders such as `tern.ui.table` don't
truncate, so cap long views yourself.

## Blocks

| Limit | Value | At the limit |
| --- | --- | --- |
| Frame message size | 64 KiB | Larger frames are split into chunks the surface protocol reassembles |
| Pending input from the pane | 16 MiB | An incomplete sequence larger than this is dropped |
| CSI or SS3 key sequence | 64 bytes | Longer sequences are dropped |

## Window half

| Limit | Value | At the limit |
| --- | --- | --- |
| Chrome formatter cache | 256 inputs per formatter | The cache is cleared and refilled |
| Pane and tab ids in Lua | The host's own id below 2^44; a remote host's tag above it | Ids stay exact in a Lua number |

## Shared API

| Limit | Value | At the limit |
| --- | --- | --- |
| `tern.process.run` output | 16 MiB per stream | The rest is read and discarded |
| `tern.process.run` timeout | None unless `timeout_ms` is given | The process is killed, `timed_out = true`, `status = -1` |
| `tern.fetch` response body | 16 MiB | The request fails with `error` (nothing is truncated) |
| `tern.fetch` timeout | 30 s unless `timeout_ms` is given | The request fails with `timed_out = true` |
| `tern.fetch` redirects | 10 | The request fails with `error` |
| `tern.json.encode` nesting | 128 levels | Raises `cannot encode tables nested this deep (or cyclic) as JSON` |
| Integers in JSON | Exact up to 2^53 | Larger integral numbers encode as floats |
| `tern.process` on iOS | Not available | Raises `tern.process is not available on iOS` |

Timers, processes, requests in flight, `tern.kv` keys and `tern.fs` reads
have no count or size caps of their own; the VM's memory limit and the call
budget bound them.

## Watching and reload

| Limit | Value | Meaning |
| --- | --- | --- |
| Change batching | 300 ms | Changes within this window cause one reload |
| Fallback poll interval | 2 s | Where no native watch is live (iOS, network volumes, inotify exhausted) |
| Poll fingerprint depth | 8 directory levels | Deeper changes aren't noticed by the poll |
| Poll fingerprint size | 10,000 entries | Entries past this aren't noticed by the poll |

See [Lifecycle and Reload](../concepts/lifecycle.md#watching).

## Logs

| Limit | Value | Meaning |
| --- | --- | --- |
| Default filter | `warn,stencil=info` | `tern.log.info`, `debug` and `print` are dropped unless `STENCIL_LOG` enables `tern::plugin` |
| Log file rotation | 16 MiB per file, two old files kept | Applies to the whole Tern log the plugin writes into |

See [Runtime, Budgets, and JIT](../concepts/runtime.md#logs).

## Related pages

- [Runtime, Budgets, and JIT](../concepts/runtime.md)
- [Errors](errors.md) for the messages these limits produce.
