# Support Matrix

Plugins run fully on macOS, Linux and Windows desktops. The iOS client runs
window halves only, and the web tab runs no Lua at all; both still show the
blocks and lens views that their hosts' plugins produce. This page breaks
that down by capability.

## Capabilities by platform

| Capability | macOS | Linux | Windows | iOS | Web tab |
| --- | --- | --- | --- | --- | --- |
| Host half (`host` entry) | Yes, in the daemon | Yes, in the daemon | Yes, in the daemon | No; host entries are skipped | No |
| Window half (`window` entry) | Yes | Yes | Yes | Yes | No |
| Native code generation (`tern.runtime.jit`) | Yes, on CPUs Luau's code generator supports | Same | Same | No; always interpreted | Not applicable |
| `tern.process.run` | Yes | Yes | Yes | Raises `tern.process is not available on iOS` | Not applicable |
| `tern.fetch` | Yes | Yes | Yes | Yes | Not applicable |
| Plugin blocks visible | Yes | Yes | Yes | Yes, from attached hosts | Yes, from the serving host |
| Lens views visible | Yes | Yes | Yes | Yes, from attached hosts | Yes, from the serving host |
| Plugin CSS | Local packages and attached remote hosts | Same | Same | Files-app packages and attached hosts | The serving host's manifest `styles`; no `tern.css` |
| `tern plugin` CLI | Yes | Yes | Yes | No | No |
| Plugins folder watching | FSEvents | inotify | `ReadDirectoryChangesW` | Poll every 2 s | Not applicable |
| `tern.runtime.os` | `"macos"` | `"linux"` | `"windows"` | `"ios"` | Not applicable |

## Notes

**Desktop.** On all three desktop platforms the session daemon runs host
halves, one worker thread per plugin, and every window runs window halves on
its UI thread ([Architecture](architecture.md)). A window that runs its
panes without a daemon runs the host halves in its own process instead. The
daemon is reached over a Unix socket on macOS and Linux and a named pipe on
Windows; plugins see no difference. Upgrading the daemon in place, which
keeps shells running, is Unix-only; on every platform plugin blocks come
back from their saved state after a daemon restart
([Lifecycle and Reload](lifecycle.md#daemon-restart-and-upgrade)).

**JIT.** Desktop builds include Luau's native code generator and use it when
the CPU is supported; otherwise they interpret. The macOS app is signed with
`com.apple.security.cs.allow-jit` so the hardened runtime allows the
executable memory it needs. `tern.runtime.jit` and the `jit` field of
`tern plugin list --json` report it. Plugin code behaves the same either
way. See [Runtime, Budgets, and JIT](runtime.md#jit).

**iOS.** Tern on iOS is a client: its shells and host halves run on the
hosts it attaches to. Window halves load from the app's `Documents/Plugins`
folder (Files app: On My iPhone or iPad › Tern › Plugins) and run in the
interpreter. There is no command line and no `git`: copy package folders
into that folder, and use Preferences › Plugins or the palette's Reload
plugins. Because the folder cannot be watched natively, Tern polls it every
2 s. `tern.fs` works within what iOS lets the app reach, and
`tern.process.run` raises, while `tern.fetch` works. A window half on iOS
still acts on every pane in the window, all of which belong to remote hosts.

**Web tab.** The web tab (`tern web serve`) has a single host, the machine
serving the page, and loads no plugins of its own. It receives that host's
catalog, so it opens the same lens blocks as every other replica and shows
plugin blocks, lens views and effects (toasts, clipboard, opens). It also
installs the manifest `styles` of the host's Ready plugins from that
catalog, as `plugin:0:<id>:styles`, so plugin blocks and lens views look as
they do in a desktop window, and it re-installs them when the host's
plugins reload. Sheets a window half adds with `tern.css` never reach it,
since no window half runs there.

**Plugin CSS.** A window installs the manifest `styles` of every package in
its own plugins folder that the settings allow, as
`plugin:local:<id>:styles`, plus the sheets its window halves add with
`tern.css`. Each attached remote host's Ready plugins contribute
`plugin:<host>:<id>:styles` from that host's catalog; the web tab, which
has no window runtime, installs its serving host's the same way. See
[Chrome and Styling](../guides/chrome.md).

**Watching.** Where a native watch cannot cover the tree (a network volume,
Linux out of inotify watches), desktop builds fall back to the same 2 s
poll iOS uses. See [Lifecycle and Reload](lifecycle.md#watching).

## Related pages

- [Architecture](architecture.md): where each half runs and why.
- [Trust and Security](security.md): what each half can reach on each
  machine.
- [Limits](../reference/limits.md): budgets and sizes, which are the same on
  every platform.
