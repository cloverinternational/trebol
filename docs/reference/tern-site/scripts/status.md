# Account, Updates and Kickoff

These commands put the account gate, update UI and cloud kickoff progress into
known states without signing in, downloading a build or provisioning a machine.
Use them to capture account screens, update preferences and progress pills in
scripts or through `tern ctl`.

## Account

| Command | Does |
| --- | --- |
| `account signed-out` | Shows the sign-in gate and clears the account handle and picture. |
| `account waiting` | Shows sign-in waiting for the browser. |
| `account waitlisted [<username>]` | Shows the waitlist gate, optionally naming the account. |
| `account failed <message>` | Shows the sign-in failure gate with the supplied message. |
| `account signed-in [<username>] [picture <file>]` | Hides the gate, shows the account avatar and offers signing out. |

Every form makes the gate apply even in a normally ungated headless window.
It cancels any pending sign-in wait, but does not authenticate an account or
wait for a browser or network reply. Each command settles for 450 ms.

Usernames and failure messages can be quoted strings or several words; the
words are joined with spaces. Handles get one leading `@`. Signing in without
a name uses `@ada`; a waitlisted account without a name has no handle.
`failed` needs a nonblank message. `picture` must be followed by exactly one
file argument and must come after the optional name. It uses a local image:
an absolute path or an existing relative path is used directly; otherwise the
path is resolved under Tern's fixture root. Fixture-root resolution can fail.
`account signed-out` and `account waiting` ignore trailing words.

`tern ctl state` reflects these commands in `gate`: `applies`, `phase`,
`signed_in`, `handle` and `error`. Signing in sets `phase` to `off`; a failure
sets `error` to its message. Waiting and failure do not clear an earlier handle
or picture. The picture itself is not included in state.

```text
ready
account signed-out
shot account-signed-out
account waiting
shot account-waiting
account waitlisted "ada"
shot account-waitlisted
account failed "The sign-in server answered 500 (server_error)"
shot account-failed
account signed-in "ada" picture "goldens/fixtures/account-picture.png"
wait 300
shot account-picture
```

## Updates

| Command | Does |
| --- | --- |
| `update idle` | Shows an up-to-date status, checked just now. |
| `update checking` | Shows a check in progress. |
| `update downloading <percent>[%]` | Shows download progress from 0 to 100 percent. |
| `update ready` | Shows a downloaded build ready to install. |
| `update installed` | Shows a build already installed by another window. |
| `update failed <message>` | Shows an update failure. |
| `update unsupported <message>` | Shows why updates are unavailable. |

These commands are unavailable on iOS. They replace the displayed status
without checking the network or downloading or installing anything. Each
settles for 450 ms, not for a real update. `checking` and `downloading` stay in
that state until another status is supplied.

The sample release is `0.2.0 (abcdef0)` with a download size of 48,000,000
bytes. Download progress takes an integer from 0 to 100, optionally followed
by `%`; missing, nonnumeric or out-of-range progress fails. `failed` and
`unsupported` require a nonblank message and join remaining words with spaces.
`idle`, `checking`, `ready` and `installed` ignore trailing words.

A newly pending release announces an "Update ready" toast and exposes the
"Restart to update" pill and palette action. The pill is hidden while the
account gate shows. Repeating the same sample release does not announce it
again unless answering a requested check. In a headless window with no real
updater, clicking Restart only reports that updates are off; it does not
restart or install the sample build.

`tern ctl state` exposes `update.status`, `release`, `received`, `total` and
`message`. `asked` records an outstanding user-requested check; `announced`
records the announced release ID. Downloading fills byte counts; failure and
unsupported states fill `message`. Before any status or updater is present,
`status` is `off`.

```text
ready
update idle
prefs general
prefs search "update"
shot update-prefs-idle
update failed "Could not reach https://build.stencil.so: connection refused"
shot update-prefs-failed
update downloading 42
shot update-prefs-downloading
update ready
wait 7000
shot update-prefs-ready
```

## Kickoff

| Command | Does |
| --- | --- |
| `kickoff packing` | Shows "Packing stencil…". |
| `kickoff starting` | Shows "Starting a cloud machine…". |
| `kickoff installing` | Shows "Installing Tern…". |
| `kickoff connecting` | Shows "Connecting…". |
| `kickoff uploading <sent> <total>` | Shows uploaded and total megabytes. |
| `kickoff setting-up <line>` | Shows "Setting up stencil ·" followed by the supplied line. |
| `kickoff off` | Ends the simulated job and hides its progress pill. |

Kickoff commands are desktop-only. They show progress for a simulated
checkout named `stencil`, without requiring the `TERN_KICKOFF` feature flag,
a signed-in account, a checkout or a cloud connection. They do not start a
machine, upload files or open a remote session. Each settles for 450 ms; no
step waits for real work or advances automatically. The pill stays hidden
while the account gate shows.

`uploading` requires exactly two unsigned integer sizes in decimal MB
(1 MB = 1,000,000 bytes), not percentages or byte counts. It does not require
`sent` to be less than or equal to `total`. `setting-up` requires exactly one
argument: quote a line containing spaces. Other steps take no arguments;
missing or extra arguments and unknown steps fail.

There is no kickoff field in `tern ctl state`. Inspect the visible progress
pill with `tree` or capture it with `shot`; use `kickoff off` to clear the
simulated progress.

## See also

- [Scripts](index.md): running commands, syntax and fixture paths.
- [Preferences](prefs.md): opening the Updates settings section.
- [Harness Commands](harness.md): screenshots and animation timing.
- [Control Commands](control.md): inspecting state and the visible tree.
- [Remote Hosts](remote.md): driving actual remote connections.
- [Debugging](../guides/debugging.md#driving-a-window-from-a-script): driving a
  running window.
