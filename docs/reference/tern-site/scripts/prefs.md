# Preferences

`prefs` drives the settings sheet: open a page, search its settings, preview a
window theme or supply pinned host keys. Use it to capture settings screens
and to reach controls with the harness's click and keyboard commands.

## Opening and closing

| Command | Does |
| --- | --- |
| `prefs [<page>]` | Opens the named page and focuses the search field. Without a page, uses the last selected page, or General if none has been selected. |
| `prefs close` | Closes the sheet, saves pending edits and returns focus to the terminal. Does nothing if already closed. |

Page names are lowercase and case-sensitive:

| Page | Settings |
| --- | --- |
| `general` | Shell, agent command, tabs and selection. |
| `appearance` | Themes, appearance and interface style. |
| `terminal` | Program surfaces and the built-in profile. |
| `databases` | SQLite blocks. |
| `notebooks` | Notebook kernel, editing, running, outputs and saving. Desktop only. |
| `carly` | Model, memory, voice and heartbeat. Desktop only. |
| `keyboard` | Shortcuts. |
| `git` | Git blocks and the focused repository. Desktop only. |
| `plugins` | Plugin loading, reloading and installation. |
| `sessions` | Session daemon and launch. |
| `hosts` | Remote hosts and pinned keys. |
| `advanced` | Files and one-time offers. |

An unknown page or subcommand fails with the available page names. On iOS
and web builds, `notebooks`, `carly` and `git` are not valid page names.
Trailing arguments after a valid page or `close` are ignored.

`tern ctl state` reports the selected page in `prefs.page`. While closed,
`prefs` is `null`. Closing also ends the temporary theme and prompt previews.

## Searching and previewing

| Command | Does |
| --- | --- |
| `prefs search [<query>]` | Sets the search query, opening the sheet if needed. Omitting the query or passing `""` clears the search. |
| `prefs preview <theme>` | Previews a catalog theme on the whole window, as if its gallery tile were hovered. |

Search finds settings across pages, not just the selected page. Search and
preview join all remaining words with spaces; quote multiword text to make
its boundaries clear. Preview requires a nonempty theme name and fails with
`no theme called …` when the theme is absent from the catalog. It does not
open the sheet or save the theme; open `prefs appearance` first to show its
gallery tile. Closing the sheet restores the saved theme.

`tern ctl state` exposes `prefs.query` and `prefs.preview` (the previewed
theme name, or `null`). `prefs.prompt_preview` describes the prompt preview
controlled through the Terminal page's controls; there is no separate
`prefs` subcommand for it.

This example follows the Appearance golden:

```text
ready
prefs appearance
prefs preview "dark-nord"
shot prefs-appearance
prefs close
```

The Keyboard golden searches for shortcut rows and settings mentioning
splits:

```text
ready
prefs keyboard
shot prefs-keyboard-table
prefs search "split"
shot prefs-keyboard
prefs search
prefs close
```

## Pinned host keys

| Command | Does |
| --- | --- |
| `prefs known-hosts <file>` | Makes the Hosts page read pinned keys from this file instead of Tern's normal `known_hosts` file, and refreshes the sheet. |

The file argument is required; all remaining words are joined as its path.
An absolute path is used as given. A relative path that exists in the current
directory is used there; otherwise it is resolved against the fixture root
(see [Fixtures](index.md#fixtures)). Resolving that root can fail. The command
does not require the resolved file to exist and does not open the Hosts page.

The Hosts goldens use `prefs known-hosts "goldens/fixtures/known_hosts"`
followed by `prefs hosts`. Headless runs otherwise have no default pinned-key
file; ordinary windows use Tern's normal file. The supplied path is not
included in `tern ctl state`, and changing it alone does not select a page
or change `prefs.page`.

## Timing

Every successful `prefs` command settles for 450 ms of animation time. None
waits for a shell, connection or other real-time operation, and there is no
command-specific real-time timeout. These commands work in headless runs
and ordinary windows; the page availability limits above still apply.

## See also

- [Scripts](index.md): syntax, running scripts and fixtures.
- [Harness Commands](harness.md): clicking settings and capturing screenshots.
- [Terminal and Panes](terminal.md): setting fonts and themes directly.
- [Remote Hosts](remote.md): staging hosts for the Hosts page.
- [Debugging](../guides/debugging.md): plugin status in Preferences.
