# Sessions and Blocks

These commands group tabs into named sessions, switch between them, protect
work from closing, and choose what new terminal blocks run. Use them to set
up a workspace or give an agent block a predictable command in a script.

## Sessions

| Command | Does |
| --- | --- |
| `session new [<name>]` | Creates a session, switches to it and opens its first tab. |
| `session switch <name>` | Switches to the first session matching the name, ignoring ASCII letter case. |
| `session rename <name>` | Renames the current session. |
| `session close` | Requests closure of the current session and its tabs' programs. |
| `session lock` | Toggles the current session's lock. |
| `sessions [<query>]` | Opens the palette's Sessions scope with the query filled in. |

Quote names and queries containing spaces. An omitted or blank new-session
name produces a unique random two-word name. New sessions start unlocked;
their first tab uses the new-tab directory and the `new-blocks` setting.
Explicit names need not be unique. Switching to an unknown name fails with
`no session named …`; switching and renaming require a nonempty name.
Unknown `session` subcommands fail. `session close` and `session lock` do
not take arguments, though the parser ignores trailing words for them.

Closing a session normally selects the next session, or the previous one
if there is no next session. Closing the only session leaves it present
with no tabs. A lock refuses closure of the session, its tabs and its
blocks, showing a toast rather than failing the script. Toggle the lock
again to unlock it. Confirmation and unsaved-data questions can leave the
session open; a successful command reply does not mean it was closed.

`session close` and `sessions` settle for 450 ms without waiting for an
answer to a question or a palette choice. The other commands wait in real
time until visible program panes are at a prompt or have ended, then settle
for 450 ms. The normal 20-second timeout applies; a busy session can make
switching to it time out.

In `tern ctl state`, `sessions` lists each session's `name`, tab count and
`current` flag. `tabs`, `panes` and `focused` show the resulting workspace.
The lock is not exposed in state. `palette` holds the switcher's query and
`palette_scope` identifies its scope.

## Closing policy

| Command | Does |
| --- | --- |
| `confirm-close never\|running\|always` | Sets when closing a block, tab, session or window asks for confirmation. |

The default is `running`: ask when a program other than an idle shell would
end, including a running command, an editor or an agent mid-turn. Idle
shells and agents between turns close without asking. `always` asks every
time; `never` skips this confirmation. Invalid or missing values fail.

This does not bypass locks or questions about unsaved database or notebook
data. Use the harness's dialog commands to answer questions in headless
runs. The policy also applies to quitting. It is not exposed in
`tern ctl state`; observe the affected `sessions` and `tabs` after answering.
Setting it uses the same prompt wait and 450 ms settle as above.

## Shell and agent blocks

| Command | Does |
| --- | --- |
| `block shell\|agent` | Opens the explicitly chosen kind of block and focuses it. |
| `agent-command <command>` | Sets the command future agent blocks run through the login shell. |
| `new-blocks shell\|agent` | Chooses the kind opened by new tabs and splits. |

A shell block opens beside the focused pane, in its directory; with no tab
open it gets a tab of its own. Agent blocks follow the agent-placement
preference: by default a split to the right, optionally a new tab or
replacement of the tab's only idle shell. Explicit `block` commands ignore
`new-blocks`.

New tabs and splits default to `shell`. The default agent command is `omp`;
set a deterministic command for screenshots instead of relying on an
installed agent. Changing `agent-command` does not restart existing blocks.
It requires nonempty text. `block` and `new-blocks` accept only `shell` or
`agent`; missing, extra or invalid words fail.

These commands wait in real time for visible program panes to be at a
prompt or ended, then settle for 450 ms, with the normal 20-second timeout.
A command that keeps a program busy can therefore time out. None of this
family is restricted to desktop-only or headless-only use.

State shows the new block in `tabs[].panes`, `panes` and `focused` (including
its `label`, `running`, `prompt` and `error`). Neither the configured agent
command nor the new-block kind is exposed directly in `tern ctl state`.

## Examples

Create sessions and filter the switcher, as in the sessions golden:

```text
ready
session rename "tern"
tab new
session new "website"
tab new
tab new
session new
run "printf 'deploying…\\n'"
session switch "website"
shot sessions-tabs
sessions "web"
shot sessions-filter
```

Open shell and agent blocks with the deterministic command used by the
blocks golden:

```text
ready
agent-command "printf '\\033[1m✻ Agent\\033[0m ready in %s\\n\\n> ' \"$PWD\"; sleep 600"
block shell
block agent
ready
shot blocks
```

## See also

- [Terminal and Panes](terminal.md): tabs, splits and prompt waits.
- [Tabs and Navigation](navigation.md): displaying and navigating session tabs.
- [Harness Commands](harness.md): answering dialogs and taking screenshots.
- [Scripts](index.md): syntax, timing and control endpoints.
- [Debugging](../guides/debugging.md): driving a window from a script.
