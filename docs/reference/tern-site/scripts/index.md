# Scripts

Tern can be driven by scripts: plain-text files of commands that open panes,
type into shells, click, press keys, put features into a given state and take
screenshots. The same commands go to a running window one at a time over its
control endpoint. Tern's own screenshots and regression scenarios
(`crates/tern/goldens/*.txt`) are scripts.

```text
# A split with git status beside a listing.
size 1280 800
ready
split right
run "git status"
expect "On branch"
focus left
run "ls"
shot split-status
```

## Running scripts

| Command | Does |
| --- | --- |
| `tern shot [SCENARIO...] [--out DIR] [--size WxH[@S]] [--scale S] [--theme light\|dark\|both] [--flat]` | Runs scenarios offscreen and writes a PNG plus its layout JSON for every `shot` command, into `DIR/<scenario>/` (default `target/shots/tern`). `SCENARIO` is a `.txt` file, a directory of them or the name of a Tern golden. |
| `tern serve [--control EP] [--out DIR]` | A headless window on a control endpoint, until `quit`. |
| `tern --control EP [ARGS]` | An ordinary window that also listens on a control endpoint. |
| `tern ctl [--control EP] COMMAND...` | Sends one command to `serve` or a window and prints its JSON reply. |
| `tern ctl [--control EP] --file SCENARIO` | Sends a script's commands one by one, each after the last one's reply. |

`EP` is a Unix-domain socket path or a TCP port on 127.0.0.1 (`0`: any free
port); `serve` and `ctl` default to `/tmp/tern.sock` (on Windows, `tern.sock`
in the temporary directory). `tern help dev` prints
the same summary with every command family. Every reply is one JSON line:
`{"ok":true,…}` or `{"ok":false,"error":"…"}`.

Headless runs (`shot`, `serve`) are deterministic: default settings that are
never saved, pinned clocks, no restored sessions, no plugins unless
`plugins fixtures` loads Tern's test plugins, and a synthetic test pattern
instead of the real screen.

## Syntax

- One command per line. `#` starts a comment; blank lines are skipped.
- Arguments are separated by spaces. Double-quoted strings may contain spaces
  and the escapes `\"`, `\\`, `\n` and `\t`.
- Script selectors (`click`, `a11y`, `webview`, …) are one argument: quote those with
  spaces.
- `ctl` joins its words into one command line, so put text the script parser
  needs quoted inside shell quotes: `tern ctl expect '"On branch"'`.

## Timing

Each command settles before the next runs: animations finish, or the command
waits for the work it started (a shell prompt, a git read, a database query).
Waits that depend on real work give up after 20 seconds and fail the script.
`wait MS` advances time by hand; `freeze-anims` and `motion-at MS` stop it to
capture motion mid-flight.

A command Tern cannot run on this platform is skipped with a warning. Some
commands stop the rest of a script without failing it when a precondition
doesn't hold.

## Fixtures

Commands that open fixtures (`file fixture`, `sqlite fixture`, `board
fixture`, `{fixtures}` in `run`, …) read them from Tern's source tree:
`crates/tern/goldens/fixtures` in a developer build. A shipped Tern needs
`STENCIL_FIXTURE_ROOT` set to a checkout's `crates/tern` for them; commands
that take your own paths work without it.

## State

`tern ctl state` prints Tern's state as JSON: panes, tabs, sessions, settings
and one entry per kind of block (`file_blocks`, `git_blocks`,
`sqlite_blocks`, `carly`, …). Scripts use it to check what a command did; each
page below names the part it fills.

## Command families

A script mixes three kinds of command: the harness's input and capture
commands, which every Stencil app shares; control commands, which only a
control endpoint answers; and Tern's own commands, grouped by the part of Tern
they drive.

| Family | Commands | Page |
| --- | --- | --- |
| Harness | `size`, `wait`, `move`, `down`, `up`, `click`, `dblclick`, `hover`, `key`, `type`, `wheel`, `swipe`, `touch`, `drop`, `shot`, `freeze-anims`, `motion-at`, `appearance`, `menu`, `a11y`, `dialog`, `webview`, `spelling`, … | [Harness Commands](harness.md) |
| Control | `dump`, `tree`, `pick`, `state`, `stats`, `layers`, `a11y`, `menus`, `system`, `css`, `perf`, `trace`, `resize`, `quit`, `webcall`, `webreports` | [Control Commands](control.md) |
| Terminal and panes | `ready`, `git-read`, `link-read`, `run`, `expect`, `completing`, `split`, `close`, `zoom`, `equalize`, `focus`, `resize`, `tab`, `rename`, `palette`, `find`, `context`, `font`, `font-family`, `font-weight`, `adjust-cell-height`, `ui-font`, `code-font`, `decorations`, `layout`, `theme`, `themes`, `scroll`, `copy`, `alert`, `inbox`, `peek`, `melt`, `feed`, `surface-play`, `plugins` | [Terminal and Panes](terminal.md) |
| Tabs and navigation | `tabs`, `filter`, `status-bar`, `pane-headers`, `style`, `interface-style`, `picker`, `goto`, `insert-path`, `running`, `drag-pane`, `move-pane`, `tidy`, `previous-tab`, `cross-session-click` | [Tabs and Navigation](navigation.md) |
| Sessions and blocks | `session`, `sessions`, `block`, `agent-command`, `new-blocks`, `confirm-close` | [Sessions and Blocks](sessions.md) |
| Remote hosts | `remote` | [Remote Hosts](remote.md) |
| Preferences | `prefs` | [Preferences](prefs.md) |
| Browser blocks | `browser` | [Browser Blocks](browser.md) |
| Pictures in picture | `pip` | [Pictures in Picture](pip.md) |
| Files pane | `files` | [Files Pane](files.md) |
| File blocks | `file` | [File Blocks](file.md) |
| Task manager | `procs` | [Task Manager](procs.md) |
| Screen blocks | `screen` | [Screen Blocks](screen.md) |
| Git blocks | `git` | [Git Blocks](git.md) |
| SQLite blocks | `sqlite` | [SQLite Blocks](sqlite.md) |
| Notebook blocks | `notebook` | [Notebook Blocks](notebook.md) |
| Board blocks | `board` | [Board Blocks](board.md) |
| Profile blocks | `profile` | [Profile Blocks](profile.md) |
| Account, updates and cloud | `account`, `update`, `kickoff` | [Account, Updates and Kickoff](status.md) |
| Carly | `carly` | [Carly](carly.md) |

Git, notebook, Carly and kickoff commands run on desktop builds only.

## See also

- [Debugging](../guides/debugging.md#driving-a-window-from-a-script): testing a
  plugin from a script.
- [Command Line](../reference/cli.md): `tern plugin` commands.
