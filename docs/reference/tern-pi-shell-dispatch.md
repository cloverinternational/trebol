# Bare `pi` in Tern: local shell dispatch for dogfooding

This is **configuration**, not a Pi extension or a modification to Pi core.
Pi 1.1.0 starts its own TUI before extensions can select a renderer (see
[extension-only blocker](pi-tern-extension-default-blocker.md)). The user's
existing `~/.zshrc` already sources an optional `~/.zshrc.local`. We created
that previously absent local file with one source line for
`.pi/config/tern-pi.zsh`. The `pi()` function chooses the Pi SDK/TSP frontend
*before* either terminal UI starts. It invokes `command node` with
the existing `.pi/lib/tern/run.ts`; it invokes `command pi "$@"` otherwise,
which bypasses the function and preserves the original executable. No alias,
PATH precedence change, Pi core edit, or second renderer was introduced.

The TSP route requires all of: no arguments, interactive bash/zsh, both stdin and
stdout TTY, `TERM_PROGRAM=tern`, `TERN_PANE` set, `PI_TERN_UI` not `0`, and
the runner readable. The runner itself performs a TSP hello handshake and
falls back if Tern does not answer. All argument-bearing uses (`pi --help`,
`pi --mode rpc`, `pi --version`, `pi -p …`), noninteractive scripts, pipes,
non-Tern terminals and `PI_TERN_UI=0 pi` keep native Pi. Programs launching
the executable directly instead of an interactive zsh command also keep
native Pi. This is a deliberately narrow dogfood route, not a global CLI
replacement.

## Live check

In an ordinary new Tern shell pane (`889058230274`) we typed
`whence -w pi; pi`. `whence` returned `pi: function` and `tern process`
showed foreground `node --experimental-strip-types
/Users/swarm/Work/Clover/trebol/.pi/lib/tern/run.ts`, not Pi's built-in TUI.
`tern capture --surfaces` showed a submitted user prompt and assistant reply
`DEFAULT_PI_TERN_OK`. Two idle Escape presses returned to the shell. In that
same pane `pi --version` printed `1.1.0`, foreground zsh afterward. Separately,
non-Tern, disabled and noninteractive zsh checks printed the native `1.1.0`;
`pi --help` printed native usage. `zsh -n` passed for both config files and
the existing `.pi/test/tern/` suite passed 48 tests.

## Limits and rollback

This TSP runner still has unbound extension UI: confirmations deny, select/
input are unavailable. It is **not** feature parity with native Pi or omp.
Live cancellation, extension approval dialogues, model/session controls and
resume have not been verified. Use `PI_TERN_UI=0 pi` for a normal Pi TUI when
you need them. Do not use the TSP mode for approval-sensitive work until
extension UI is implemented and tested.

`pi -nt` is a **shell-function option**, not a new Pi CLI flag: a single
leading `-nt` is removed and the remaining argv goes to `command pi` with
its exit status; `pi -nt --version` invokes native Pi. A second or nonleading
`-nt` is passed through unchanged, so Pi may reject it. This avoids silently
changing arguments for scripts or programs that invoke the Pi executable
directly. The existing `PI_TERN_UI=0 pi` bypass remains available.

Rollback: remove the single source line from `~/.zshrc.local` (or delete that
file if still unchanged from its two initial lines), then open a fresh shell.
Immediate per-command bypass: `PI_TERN_UI=0 pi` or `command pi`. The existing
`~/.zshrc` and `.pi/lib/tern` TSP implementation were not modified by dispatch.
