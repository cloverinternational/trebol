# API Reference

The `tern` module is the whole plugin API. Each half of a plugin gets its own
copy: the shared members exist in both, and each context adds its own. This
page indexes the module by context and sets the notation the three member
pages use.

## Getting the module

The module is installed as the global `tern` before the entry runs, and
`require("tern")` returns the same table. Global `print` is `tern.log.info`.

```lua
print(tern.context, tern.plugin.id, tern.runtime.jit)
```

`require` with any other string loads a Luau module relative to the requiring
file (`require("./util")` finds `util.luau`, `util.lua`, or `util/init.luau`)
and never leaves the plugin directory; `.luaurc` aliases are not read. See
[Runtime, Budgets, and JIT](../concepts/runtime.md).

## Types for luau-lsp

`tern plugin types DIR` writes `DIR/tern.d.luau`, the definition file the
runtime ships. Register it with
luau-lsp as a definition file and both entries type-check against the
declared global `tern`:

```sh
tern plugin types ~/src/my-plugin
```

```json
{
  "luau-lsp.platform.type": "standard",
  "luau-lsp.sourcemap.enabled": false,
  "luau-lsp.types.definitionFiles": { "@tern": "tern.d.luau" }
}
```

luau-lsp does not resolve `require("tern")` (it reports an unknown require);
use the global `tern` in code you type-check. Annotate definitions as
`BlockDef<MyState>` or `LensDef<MyState>` to type their state. The definition
file marks members of one context `Host only` or `Window only` in their
docs; it declares one `tern` for both entries, so the checker does not stop
a window entry from calling a host member.

## Contexts

`tern.context` is `"host"` in the VM running `host.luau` and `"window"` in a
VM running `window.luau`. A member of the other context is absent (`nil`):
using it raises Luau's own error (`attempt to index nil with 'define'` for
`tern.block.define` in a window entry, `attempt to call a nil value` for
`tern.command` in a host entry). Branch on `tern.context` when one module
serves both entries.

| Member | Host | Window | Page |
| --- | --- | --- | --- |
| `tern.context`, `tern.plugin`, `tern.runtime` | yes | yes | [Shared](api-shared.md#identity) |
| `tern.log`, `tern.json`, `tern.now`, `tern.getenv`, `tern.timer` | yes | yes | [Shared](api-shared.md) |
| `tern.kv`, `tern.fs`, `tern.process` | yes | yes | [Shared](api-shared.md#storage) |
| `tern.fetch` | yes | yes | [Shared](api-shared.md#network) |
| `tern.ui`, `tern.parse` | yes | yes | [UI Builders](ui.md) |
| `tern.block.define` | yes | no | [Host](api-host.md#ternblockdefine) |
| `tern.lens.define` | yes | no | [Host](api-host.md#ternlensdefine) |
| `tern.pane.write`, `tern.pane.list` | yes | no | [Host](api-host.md#ternpane) |
| `tern.on` | host events | window events | [Host](api-host.md#ternon), [Window](api-window.md#ternon), [Events](events.md) |
| `tern.command`, `tern.bind`, `tern.override` | no | yes | [Window](api-window.md) |
| `tern.route.open`, `tern.route.link` | no | yes | [Window](api-window.md#ternrouteopen) |
| `tern.chrome.tab_title`, `window_title`, `status` | no | yes | [Window](api-window.md#chrome-formatters) |
| `tern.chrome.refresh` | no | yes | [Window](api-window.md#ternchromerefresh) |
| `tern.css` | no | yes | [Window](api-window.md#terncss) |

`tern.on` exists in both contexts with different event sets; an event name
the context doesn't know raises at the call.

The handler context `cx` differs by what called the handler:

| `cx` | Received by | Members | Page |
| --- | --- | --- | --- |
| Effect cx | Lens `open` and `event`, host event handlers | `toast`, `open`, `copy` | [Host](api-host.md#effect-cx) |
| Block cx | Every block handler | Effect cx plus `pane`, `cwd`, `cols`, `rows`, `render`, `save`, `exit`, `frame`, `blob` | [Host](api-host.md#block-cx) |
| Window cx | Commands, binds, overrides, routes, window events, window timers, process and fetch callbacks | `session`, `layout`, `run`, `open`, `new_block`, `command`, `toast`, `copy` | [Window](api-window.md#window-cx) |

Chrome formatters receive no `cx`. Host timer, process and fetch callbacks
receive none either.

## Notation

- Signatures use Luau type syntax as `tern.d.luau` declares them. `T?` is an
  optional value (`T` or `nil`); a field written `name: T?` may be absent.
- A method written `cx:name(...)` is called with `:`.
- **Raises** means the call throws a Lua error with the quoted text; the
  calling handler fails unless it catches the error with `pcall`.
- A handler that fails, or runs past its budget, is reported as a toast
  "Plugin *name*: *hook* failed" and in the log; the hook name each page gives
  is the one that appears there. See [Errors](errors.md#handler-failures).
- Byte offsets, lines and columns are 1-based. Times are milliseconds.
- Pane and tab ids are Lua numbers. Pass them back unchanged; see
  [Window API](api-window.md#pane-and-tab-ids) for how remote ids are packed.

## Where the declarations and the runtime differ

The runtime is authoritative. Where `tern.d.luau` declares something
narrower or different, the member pages say so in their notes:

- `LinkRequest.pane` is `nil` for links with no pane (URLs the system
  hands Tern); the declaration says `number`.
- `cx.layout:move` and `cx.layout:resize` return a boolean (whether
  anything moved); the declarations return nothing.
- `LensDef.finish` always receives a number; the declaration allows `nil`.
- Block `cx:exit` takes an optional code (default `0`).
- `tern.ui.badge` accepts a missing `tone`.
- Host `cx:toast` accepts any level string; see
  [Effect cx](api-host.md#effect-cx).
- The window context also delivers a `title` event, which the declaration's
  list for `tern.on` omits.
- `tern.css` installs sheet `plugin:local:<plugin>:<name>`.

## Pages

- [Shared API](api-shared.md): identity, logging, JSON, time, timers,
  key/value storage, files, processes, HTTP requests.
- [Host API](api-host.md): blocks, lenses, host events, panes, and their `cx`
  types.
- [Window API](api-window.md): commands, binds, overrides, routes, chrome,
  CSS, window events, and the window `cx` with `cx.session` and `cx.layout`.
- [UI Builders](ui.md): every `tern.ui` builder and `tern.parse` helper.
- [Events](events.md): every `tern.on` event with its payload.
