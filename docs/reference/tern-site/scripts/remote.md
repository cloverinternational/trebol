# Remote Hosts

`remote` drives host connections, the Add remote host dialog, host popovers
and remote-shell link conditions. Use it to exercise remote UI without a
remote machine: loopback hosts run a real session daemon locally, while
connection states, SSH setup progress and presence can be staged.

## Hosts and connections

| Command | Does |
| --- | --- |
| `remote loopback <address>` | Attaches an in-process daemon as a host, shows its session and moves its first shell to the previously focused pane's directory. |
| `remote state <name> connected\|connecting\|stalled` | Sets a host's connection state directly. |
| `remote state <name> reconnecting [<message>...]` | Sets a reconnecting state at attempt 2. |
| `remote state <name> failed [<message>...]` | Sets a failed connection state. |
| `remote state <name> verify <fingerprint>` | Sets a host-key verification state. |
| `remote identity <name> <principal> local\|ssh-key\|tailscale <from> <user>` | Replaces the host's identity chain with one hop: principal, authentication method, originating machine and acting user. |
| `remote service <name> <version>\|old [system]` | Stages the host's Tern service version and update capability. |
| `remote switch <name>` | Switches to the named host. |
| `remote disconnect <name>` | Disconnects the named host. |

Host names match without regard to ASCII case; an unknown name fails. Use
`remote loopback` or `remote stage` to create a host before setting its
state. Invalid addresses fail. A loopback address such as `can@devbox`
creates the host named `devbox`.

Loopback waits up to three seconds for its daemon to answer, then waits for
shell readiness, subject to the script's 20-second real-time timeout.
Other commands in this group settle for 450 ms; setting `connected` does
not create a working connection by itself.

The default reconnecting message is `the network went away`; the default
failed message is `the connection timed out`. Only these two states accept
a message. Messages are the remaining words, joined with spaces. Remote
arguments are split on whitespace again after script parsing, so quoting
cannot make a host name or identity argument contain spaces.

`service` accepts a version string without validating its format. A normal
version stages a user service that accepts updates over the link; `system`
stages a system service without that capability. `old` represents a service
from before version reporting and ignores `system`. Older services can
show an Update offer in Preferences › Hosts.

Inspect `hosts.current` and `hosts.hosts[]` in `tern ctl state`. Each host
entry includes `name`, `address`, `state`, `sessions`, `identity`, `tern`
(the reported version) and `update` (the offered update or its progress).

## Dialogs and host selection

| Command | Does |
| --- | --- |
| `remote add [<address>]` | Opens Add remote host, optionally filling its address. |
| `remote stage <address> [<fingerprint>]` | Stages a connecting host, or one waiting for key verification, and follows it in the dialog. |
| `remote peers [<name>...]` | Replaces the dialog's tailnet peer list. |
| `remote ssh-hosts [<alias>...]` | Replaces the dialog's SSH-config host list. |
| `remote popover [<name>]` | Opens a host popover; defaults to the current host. |
| `remote hosts` | Opens the palette's Hosts scope for switching hosts. |

`add` without an address starts with an empty field. `stage` opens the
dialog if necessary; its address must parse. A fingerprint is displayed
for verification, not checked against a real remote key. Setting the
followed host to `connected` closes the dialog.

Peer and SSH-host lists may be empty, clearing the staged list. Tailnet
peers get synthetic online Linux details and addresses on port 8376;
`ssh-hosts` supplies aliases rather than reading `~/.ssh/config`. These
commands stage discovery results, not network discovery. All commands in
this group settle for 450 ms.

State exposes the popover's host as `hosts.popover`. `hosts.dialog` is null
when closed; otherwise it includes `address`, pending `host` and `state`,
`peers` and `ssh` counts, the `primary` button label and `setup`. The Hosts
palette has no dedicated field in `hosts`; inspect it with `tree`.

## SSH setup

| Command | Does |
| --- | --- |
| `remote setup <destination>` | Opens the dialog if needed and stages an SSH setup without starting an SSH engine. |
| `remote setup-step login\|inspect\|install\|service\|route [<note>...]` | Advances the staged setup to a step, optionally supplying its progress note. |
| `remote setup-fail login\|inspect\|install\|service\|route <error>... [terminal]` | Fails the setup at a step; a final `terminal` marks a failure requiring an interactive terminal. |
| `remote setup-offer <name>` | Marks a staged host as eligible for SSH setup and follows it in the dialog. |

These four forms are desktop-only, not available on iOS. They stage UI
progress; they do not install Tern or log in over SSH. Start with `setup`
before sending progress or failure events. To show a setup offer, stage a
host, set its state to `failed`, then use `setup-offer`.

Unknown steps fail parsing. Notes and errors consume the remaining words,
joined with spaces. An error is required. A final `terminal` is a flag only
when at least one error word precedes it; alone it is the error text.
Commands settle for 450 ms, not for a real SSH operation.

Inspect `hosts.dialog.setup`: `destination`, `step`, `note`, `failed`,
`needs_terminal` and `done`. `step` uses capitalized names such as `Install`.

```text
ready
remote add
remote peers devbox
remote ssh-hosts spark build-01 gpu-box pi-garage
shot remote-setup-hosts
remote setup spark
remote setup-step login
remote setup-step inspect
remote setup-step install Downloading Tern 0.5.1 for linux-arm64 on spark…
shot remote-setup-install
```

## Link conditions and presence

| Command | Does |
| --- | --- |
| `remote rtt <name> <ms>\|off` | Overrides the link's round-trip estimate, or restores its own estimate. |
| `remote hold <name>` | Lets in-flight output land, then holds subsequent host output. |
| `remote release <name>` | Releases held output and applies what arrived meanwhile. |
| `remote peer-join <name> <identity>` | Stages another client from machine `<name>` on the current host. |
| `remote peer-leave <name>` | Removes staged clients from that machine on the current host. |

`rtt` takes a nonnegative integer number of milliseconds. Predictive echo
starts guessing above 30 ms and underlines guesses above 80 ms. This
changes the estimate seen by panes, not the network's actual latency.

`hold` allows 300 ms of real time for in-flight output before holding the
rest. It waits until the hold is in force, then settles for 100 ms; the
usual 20-second real-time wait timeout applies. `release`, `rtt` and
presence commands settle for 450 ms.

For presence commands, `<name>` is the other client's originating machine,
not a host to look up. The staged identity uses tailnet authentication and
the current host's acting user, or the part of `<identity>` before `@` if
the host has no identity chain. `peer-leave` fails when nobody from that
machine is attached.

`tern ctl state` has no dedicated RTT, output-hold or peer-presence field.
Use pane output and `shot` to inspect predictive echo; open the host
popover to inspect presence. `hosts.current` identifies the host affected
by presence commands.

```text
ready
remote loopback can@devbox
agent-command "env -i HOME=$HOME TERM=$TERM PS1='devbox$ ' /bin/sh -i"
block agent
zoom
ready
remote rtt devbox 400
type "e"
remote hold devbox
type "cho hello"
shot remote-echo
remote release devbox
shot remote-echo-landed
```

## See also

- [Scripts](index.md): running commands, syntax and timing.
- [Terminal and Panes](terminal.md): shell readiness, typing and output.
- [Preferences](prefs.md): host settings and update offers.
- [Control Commands](control.md): state and UI inspection.
- [Debugging](../guides/debugging.md): driving a running window.
