# Trust and Security

Installing a plugin means trusting it. A plugin runs as you, with the same
access to your files, programs and shells that you have, and Tern has no
permission system to narrow that. This page explains the trust model, what
the Luau sandbox is and is not for, what a plugin can reach, how remote
hosts change the picture, and how to install and write plugins with that in
mind.

## The trust model

Tern treats plugins the way Neovim treats its Lua plugins and WezTerm its
Lua configuration: as code you chose to run. There is no review, no signing,
no list of permissions in `plugin.toml`, and no prompt before a plugin does
something. A package starts running as soon as it is in the plugins folder:
`tern plugin install`, `link` and a copy into the folder all lead to a reload
(through the CLI or the folder watch), which runs its entries.

| Question | Answer |
| --- | --- |
| Who decides what runs? | Whoever can write to `<config>/plugins/`, or to a package directory a `.path` file or symlink points at |
| With whose rights does it run? | The user running the process: the session daemon for host halves, the window for window halves |
| What is asked before it runs? | Nothing |
| What turns it off? | `plugins_disabled` (or `plugins: false`) in `settings.json`, removing the package, or `tern plugin unlink`; a Disabled plugin's entries never run |

The model is deliberate. A terminal plugin is useful because it can run
`kubectl`, read your project files and type into your shells; a permission
system that allowed those things would gate very little, and one that did
not would leave plugins unable to do their job.

## What the sandbox is for

Each plugin half runs in a sandboxed Luau VM
([Runtime, Budgets, and JIT](runtime.md#the-vm)). The sandbox keeps a buggy
plugin from hurting Tern; it does not keep a hostile plugin from hurting you.

| Sandbox feature | Protects against | Does not stop |
| --- | --- | --- |
| No `io`, no `os.execute`, `os.getenv` or `os.remove` | Code reaching the system by accident, outside `tern`'s error handling | `tern.fs`, `tern.process` and `tern.getenv`, which do the same things |
| `require` confined to the package directory | A module path that silently loads someone else's code | `tern.fs.read` of any file |
| Read-only built-in libraries | One module breaking `string` or `table` for the others | Anything outside the VM |
| Time budgets (4 ms, 50 ms, 2 s) | An infinite loop freezing a window or a worker | Long work moved into a process or spread over timers |
| 256 MiB memory limit | A runaway table exhausting the process | A process the plugin starts |
| One VM per plugin and half | One plugin's globals or errors affecting another | One plugin writing another's package or data folder through `tern.fs` |

Every way out of the VM goes through `tern`, so the `tern` API is the
complete list of what a plugin can do directly. It is not a narrow list.

## What a plugin can reach

| Reach | Host half | Window half |
| --- | --- | --- |
| Files | `tern.fs` reads, writes and removes any path the daemon's user can, on the host | The same, on the machine the window runs on |
| Programs | `tern.process.run` starts any program with any arguments, inheriting the daemon's environment plus `TERN_PLUGIN_DATA` | The same, from the window's process; raises on iOS |
| Network | `tern.fetch` sends any HTTP(S) request, with any method, headers and body, from the daemon's machine | The same, from the machine the window runs on, iOS included |
| Environment | `tern.getenv` reads the daemon's environment | `tern.getenv` reads the window's environment |
| Shell input | `tern.pane.write` types into any pane on the host | `cx:run` types into any pane in the window, remote hosts' panes included |
| New shells | The `spawn` filter can change the program, arguments, directory and environment of every shell the host starts | `cx.layout` opens tabs and splits running commands |
| What you run | `command_started` and `command_finished` carry every command line; `tern.pane.list` gives every pane's directory, program and title | The same events and `cx.session` for every pane in the window |
| Command output | A lens receives every line of the commands its `match` globs claim | Nothing directly |
| Your window | Effects in the windows showing the pane: toasts, the clipboard (`cx:copy`), and opening a path or URL (`cx:open`), which follows the same rules as clicking a link | Overrides of built-in commands, key binds, routes that see every open and link click first, chrome text, and style sheets over all of Tern's UI |

`tern.process.run` takes an argument vector and starts the program directly,
without a shell. `tern.fetch` reaches any HTTP(S) server the machine can,
`localhost` and the local network included, so it is one more way data can
leave the machine. Any other program, such as `curl` or `ssh`, is still one
`tern.process.run` away.

Plugin data is not private either. `<state>/plugin-data/<id>/` and
`kv.json` are ordinary files that every plugin and program running as you
can read and write. See [Files, Processes, and Storage](../guides/io.md).

## Remote hosts

When your window attaches to another machine, two sets of plugins are in
play, and they run in different places with different rights:

| Plugin | Runs on | As | Reaches |
| --- | --- | --- | --- |
| The remote host's host halves | The remote machine, in its daemon | The user that daemon runs as | That machine's files, programs and panes |
| Your window halves | Your machine, in your window | You | Your machine, and every pane in your window, remote ones included |

A remote host's plugins never run code on your machine. What reaches your
window from them is data: their catalog (block titles and icons, lens
globs), block frames, lens views, effects (toasts, clipboard text, opens)
and their manifest styles, which your window installs as a global sheet
(`plugin:<host>:<id>:styles`). Which plugins a remote host runs is that
host's owner's decision, made in that host's plugins folder.

Your window half, on the other hand, works across hosts: `cx:run` accepts
any pane in the window, so text a window plugin types into a remote shell
runs on that host with that shell's rights. Install a window
plugin as if it could type into every shell you have open, because it can.

## No permission system

Tern does not declare, check or prompt for capabilities, and does not sign
or verify packages. Everything a plugin can do, it can do from the moment
its entry runs. The controls that exist are coarse:

- `plugins: false` in `settings.json` loads no plugin on that machine.
- `plugins_disabled` keeps listed plugins from loading; Preferences ›
  Plugins has a switch per plugin.
- Each machine reads its own settings and plugins folder: disabling a
  plugin on your Mac does not disable it on a remote host, and the other
  way round.

See [Packages and Manifests](packages.md#settings).

## Recommendations

**Installing.**

- Read a plugin before you install it: `plugin.toml`, both entries, every
  module they `require`, and every `tern.process.run`, `tern.fetch`,
  `tern.fs.write`, `tern.fs.remove`, `tern.pane.write` and `cx:run` call.
- Install the code you read. `tern plugin install` with a git URL makes a
  shallow clone of the default branch as it is at that moment, so what you
  install may not be what you reviewed earlier. To pin a commit, clone the
  repository yourself, check out the commit you reviewed, and install from
  the directory:

  ```sh
  git clone https://github.com/example/tern-k8s
  git -C tern-k8s checkout 3f2a9c1
  tern plugin install ./tern-k8s
  ```

  The installed copy leaves out `.git` and never updates itself; a later
  `tern plugin install --force` replaces it.
- Keep the plugins folder, and every directory linked into it, writable
  only by you: anything written there runs at the next reload.
- `tern plugin list` and Preferences › Plugins show what is loaded. Disable
  a plugin you are unsure of rather than leaving it running.

**Developing.**

- Work on a plugin with `tern plugin link DIR`: Tern loads it from your
  checkout and reloads on every save, and `tern plugin unlink ID` takes it
  out again. See [Distribution](../guides/distribution.md).
- Treat pane output, command lines, file names and lens input as untrusted
  text. Never build a `cx:run` or `tern.pane.write` string out of them
  without quoting, since that text runs in the user's shell; prefer
  `tern.process.run` with an argument vector.
- Keep secrets out of `tern.kv` and the data folder, which are plain files.
- Say in your README which programs the plugin runs, which servers it
  contacts and which files it writes, so users can review it quickly.

## Related pages

- [Architecture](architecture.md): where each half runs.
- [Runtime, Budgets, and JIT](runtime.md): the sandbox in detail.
- [Distribution](../guides/distribution.md): installing, linking and
  publishing.
