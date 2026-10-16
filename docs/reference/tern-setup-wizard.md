# Optional Tern Pi setup wizard

Trebol's `extensions/clover-startup/extension.ts` offers a confirmation during
the native Pi TUI's interactive `session_start` on macOS or Linux if the active
shell is bash or zsh and the TSP runner exists. The same extension exposes
`/tern-setup` to install or remove the integration later. Decline, EOF,
noninteractive modes, unsupported shells, and already-installed startup skip
all writes. A current unbound TSP runner does **not** show the wizard because
its extension UI is unavailable; run `PI_TERN_UI=0 pi` then `/tern-setup` if
you have already enabled the dispatch. This is a setup step for the shell,
not an extension replacing Pi's renderer.

After an explicit **Yes**, `.pi/lib/ui/tern-shell-setup.ts` installs a uniquely
marked source block in zsh's `$ZDOTDIR/.zshrc` (or `~/.zshrc`) or bash's
`~/.bashrc` if already present plus the first existing login profile
(`~/.bash_profile`, `~/.bash_login`, `~/.profile`). If neither exists it
creates `~/.bash_profile`. It never creates `.bash_profile` ahead of a user's
existing `.profile`, and does not create a dormant `.bashrc`. The block only
sources `.pi/config/tern-pi.zsh` in interactive shells; it passes the runner
path from this installation through `TREBOL_TERN_RUNNER`. A no-argument `pi`
under a verified Tern TTY enters the TSP frontend; flagged, non-Tern and
script uses run `command pi "$@"`. `PI_TERN_UI=0 pi` bypasses immediately.

The editor preflights all target files, rejects symlinks/non-files, files over
1 MiB and modified marker blocks, and writes a temp file in the same directory
before rename. It preserves surrounding bytes and mode bits, makes repeated
install a no-op, and on an error attempts rollback only if its own just-written
contents remain unchanged. Do not use the wizard to "repair" a user-modified
owned block; inspect and edit it manually. `/tern-setup` in an installed native
Pi session offers removal of only the exact managed block. It cannot undo
unmanaged pre-existing aliases/functions such as a manual `~/.zshrc.local`
source; that file is not touched.
If a legacy `~/.zshrc.local` already sources this same dispatch script, the
wizard reports a conflict and makes no edit. This machine currently has such
an older manual override; its existing behavior is intentionally preserved.

**Safety:** the TSP frontend is not yet feature-complete. It denies unbound
extension confirmations and cannot present selection/input dialogs. For
approval-sensitive work use `PI_TERN_UI=0 pi`. Reopen the shell after setup or
removal. For manual rollback remove the exact marked stanza from the files
listed in the wizard, or use `/tern-setup` from native Pi; no unrelated lines
should be changed.

Verification: `.pi/test/ui/tern-shell-setup.test.ts` (13 tests) and
`.pi/test/ui/tern-setup-extension.test.ts` (3 tests) ran alongside the
startup-viewport and TSP suite: 75 focused tests passed. Targeted TypeScript
strict checking, `bash -n` and `zsh -n` passed. Executed on macOS bash 3.2
and zsh 5.9; Linux shell paths and behavior are covered by temporary-home
fixtures but have not been live-tested on a Linux host. The earlier ordinary-`pi` Tern smoke is documented in
`tern-pi-shell-dispatch.md`; it used an unmanaged `~/.zshrc.local` source,
so it does **not** prove this wizard's installed stanza in a real new pane.
`/tern-setup` registration and startup decision are validated through the
installed Pi API and unit-level wizard tests. A Tern Pi pane invoked
`/tern-setup` on this machine, whose existing unmanaged local override was
preserved; no real-home managed install was run. Its `~/.zshrc` and
`~/.zshrc.local` sizes remained 1800 and 160 bytes respectively.
