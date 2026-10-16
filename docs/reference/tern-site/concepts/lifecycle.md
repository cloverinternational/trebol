# Lifecycle and Reload

Plugins load when the process that runs them starts, and reload as a whole
whenever their folder changes or someone asks. A reload replaces every VM in
that context; running blocks carry over through their saved state, and
running lens captures finish where they started. This page describes the
order things happen in, what triggers a reload, and what survives a reload or
a daemon restart.

## Loading

Both halves start from the same scan of the plugins folder
([Packages and Manifests](packages.md#directories)): packages sorted by id,
problems set aside, ids turned off by the settings marked Disabled.

**Host halves** load when the session daemon starts, before it restores
saved panes, so restored blocks find their block types. A window that runs
its panes without a daemon loads them when it creates its first pane. Each
allowed package with a `host` entry gets a worker thread that creates the VM
and runs the entry under the 2 s host budget; all workers start at once, and
the host waits for each to report. A plugin whose entry raises, or leaves a
declared block or lens undefined, is Failed; the others load normally.

**Window halves** load when a window is created, after Tern's own style sheets
and before the keymap is first applied. On the window's UI thread, in id
order, each allowed package has its manifest styles installed and then its
`window` entry run under the 50 ms window budget. A failing entry raises a
toast "Plugin *name* failed to load" with the error's first line and marks
that plugin Failed in this window. Once every entry has run, the window reads
what they registered: palette rows, the keymap's plugin layer, chrome
formatters and `tern.css` sheets.

**`window_start`** runs once per window per plugin, after the window's
session has settled (restored or freshly started), so a workspace script sees
the tabs it is adding to. See [Layout and Workspaces](../guides/layout.md).

Wherever plugins take turns (overrides, routes, chrome formatters, the
`spawn` filter, lens claims), the order is plugin id order.

## The catalog and statuses

Each half keeps its own status for every plugin:

| Source | Status it reports |
| --- | --- |
| Host catalog | Ready, Disabled, or Failed for the host entry. A plugin without a host entry is Ready here as long as the settings allow it. |
| Window | Ready, Disabled, or Failed for the window entry, in that window. |

The host's catalog is what it sends windows (see
[Architecture](architecture.md#the-catalog)) and what `tern plugin list`
prints: the running daemon's catalog, or, with no daemon, the folder read
without running any plugin (every allowed package Ready). A window entry
that fails therefore does not show as Failed in `tern plugin list`.
Preferences › Plugins shows the worse of the host's and the window's status
for each local plugin, and lists attached remote hosts' plugins read-only
under each host's name.

Whenever a host's catalog changes (when the window attaches, and after a
reload that changed it) and it holds problems or Failed plugins, the window
shows one toast: "1 plugin has problems" or "*N* plugins have problems",
with the first error beneath.

## Watching

The plugins folder and every package directory outside it (the targets of
`.path` links and symlinks) are watched for changes:

| Platform | Mechanism |
| --- | --- |
| macOS | FSEvents, recursive |
| Linux | inotify, one watch per directory (package directories up to 8 levels deep) |
| Windows | `ReadDirectoryChangesW`, recursive |
| iOS, and wherever a watch is not live | A poll every 2 s of a fingerprint of the tree (paths, sizes, modification times; 8 levels, 10,000 entries) |

A watch that is not live (a network volume, Linux running out of inotify
watches) falls back to the poll. Changes are batched over 300 ms. Any change
reloads every plugin in the watching context, not just the package that
changed.

The daemon and each window watch independently: the daemon reloads host
halves, a window reloads its window halves.

## Reloading

| Trigger | Host halves | Window halves |
| --- | --- | --- |
| A change in a watched folder | The daemon (or the window running panes without one) reloads; if the catalog changed, the daemon sends it to every window | Each window on the machine reloads from its own watch |
| `tern plugin reload` | The daemon reloads and answers with its catalog, which it also sends to every window | Windows of this machine reload when their daemon's catalog arrives |
| `tern plugin install`, `remove`, `link`, `unlink` | As `tern plugin reload`, after the change | As `tern plugin reload` |
| Palette: Reload plugins | Every host the window is attached to reloads, remote ones included; a window without a daemon reloads its own runtime | This window reloads |
| Preferences › Plugins: a switch, Reload, Install… | As the palette command | This window reloads |

`tern plugin reload` needs a running daemon (`no daemon running`
otherwise). The mutating verbs work without one and print
`no daemon running; changes apply at next start`. See
[Command Line](../reference/cli.md).

One edit usually reloads a window twice: once from its own watch and once
when its daemon's new catalog arrives. A window reload whose load failures
are exactly the previous load's does not toast them again, and the catalog
toast only appears when the catalog changed, so a broken plugin is reported
once per change rather than once per reload.

A reload asked for while a window handler is running (from a timer, or a
command that edits the plugin folder) runs after that handler returns.

## What survives a reload

**Host halves.** The old workers are retired and new ones started from the
current folder and settings.

| Thing | After a host reload |
| --- | --- |
| Running blocks | Moved to the new worker and restarted: `init(cx, args, saved)` runs with the state their `save` returned last (`nil` for a block whose type has no `save`). The pane stays; its view is rebuilt. |
| Blocks whose type is gone | The plugin was removed, disabled or failed, or the block was dropped from the manifest: the block ends with `no block type KIND on this host` and exit status 1. |
| Running lens captures | Finish on the old worker, under the old code; the old worker exits when its last capture finishes. New commands go to the new worker. |
| Finished lens captures | Their Lua state goes with the old VM; the next event from such a block rebuilds it on the new worker ([below](#lens-rehydration)). |
| Hooks, the `spawn` filter, timers, pending process and fetch callbacks | End with the old VM; the new entry registers its own. |
| Hooks disabled by a tripped budget | Enabled again: the VM is new. |
| `tern.kv`, files in the data folder | Unchanged. |

**Window halves.** The window drops every plugin VM and builds them again.

| Thing | After a window reload |
| --- | --- |
| Lua state, registrations | Gone; the entry runs again and registers afresh. |
| Plugin style sheets | `plugin:local:*` sheets removed and installed again. |
| Keymap, palette rows, formatters | Rebuilt from the new registrations. |
| `window_start` | Runs only for plugins that have not run it in this window: a newly added or newly enabled plugin runs it, one that already ran it does not. |
| Hooks disabled by a tripped budget | Enabled again. |

Anything a window half needs across reloads belongs in `tern.kv` or a file;
anything a block needs belongs in its `save` result.

## Daemon restart and upgrade

**Restart.** When the daemon starts and finds the state file of one that
stopped (quit, crashed, or the machine restarted), it loads plugins first
and then restores the saved panes. Shells come back as login shells; a
plugin block comes back as the same block type, started from the state its
`save` returned last, at its last size, on a blank screen. Nothing outside
the block's view is kept, and a block is never restored as a shell. If no
Ready plugin on the host defines the block type any more, the pane is not
restored (the daemon logs `cannot restore plugin block`).

**Upgrade in place (Unix).** An upgrade hands the daemon over to the new
build without ending any program: shells keep their pseudoterminals,
screens and scrollback. Plugin blocks have no pseudoterminal: the plugins
stop before the handover, their last saved state is kept, and the new
daemon starts each block again from it, as a restore does. Lens state on
the workers does not survive.

Write `save` so its result is enough to rebuild the block. See
[Blocks](../guides/blocks.md).

## Lens rehydration

Lens state lives only in the worker's VM, for the most recent 256 captures
per plugin. A lens block outlives it: after a reload, a daemon restart or
upgrade, or once the capture is evicted, the block still holds its command
line, working directory, raw output, width and exit status.

When such a block sends an event (a click on a node with an action, a
selection, a toggle), the host passes that record to the worker along with
the event. The worker claims the command against its plugin's `match` globs
again; if they still claim it, it runs `open`, then `line` for each line of
the saved output replayed at the block's width, then `finish` when the
command had finished, and then the event's handler, and sends the new view.
If the globs no longer claim the command, nothing runs.

Rehydration re-runs the handlers, including any side effects they have
(toasts, processes, file writes). Keep `open`, `line` and `finish` free of
effects that should happen only once. See [Command Lenses](../guides/lenses.md).

## Related pages

- [Architecture](architecture.md): where each half runs.
- [Runtime, Budgets, and JIT](runtime.md): budgets and what a failure does.
- [Debugging](../guides/debugging.md): reading load errors and logs.
