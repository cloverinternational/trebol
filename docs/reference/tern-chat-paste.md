# Chat paste investigation — TREBOL-362

**Superseding corrections:** `tern-chat-paste-review-fixes.md` documents the
TREBOL-366 fixes, limits/watchdog, recovery quarantine, positional marker
identity and undo-owned payload retention. Statements below about missing
timeouts/caps and lifetime maps describe earlier revisions, not current code.

## Latest revision: exact-content OMP-style accumulation

This section supersedes the initial implementation's CRLF normalization and
its limitation about TSP parsing inside pasted text, described historically below.
The new `paste-input.ts` owns paste framing **before** `splitInput`/StdinBuffer.
It accumulates chunks with a five-character delimiter tail and joins once,
following OMP's algorithmic approach, not copying OMP's text sanitizer.
Protocol-shaped pasted text is never dispatched as TSP; embedded Enter is data.
Short control-bearing payloads also use markers, so raw controls are not sent
to the terminal renderer. CRLF, bare CR, tabs, combining Unicode, NUL and ESC
are preserved in expanded chat draft. Modal editors retain their prior policy.

Unlike the initial fix, this removes Pi's repeated full-paste concatenation
and scanning from the runner path. OMP's NFC normalization, tab expansion,
control deletion and path-spacing heuristics are deliberately not adopted.
OMP's inactivity flush is also not adopted: incomplete paste stays inert until
its closing delimiter arrives. There is currently no byte cap/recovery UI;
an unterminated paste can hold memory and input until restart. Literal closing
delimiter bytes cannot be distinguished from framing in bracketed-paste protocol.

Validation: `npx --no-install vitest run .pi/test/tern` — **30 files, 370 tests**.
Tests cover exact content at chunk sizes 1–15, split UTF-8 (previous lifecycle
tests), adjacent pastes/order, idle incomplete paste, TSP-shaped content,
no-submit and one render. The first new test run failed because its fixture
did not open the surface; fixed fixture and reran the complete suite.

Updated seven-trial median bridge benchmark (ms / renders, bracketed): small
0.119 / 1, large 0.148 / 1, multiline 0.097 / 1, Unicode 0.159 / 1;
all preserve content and emit zero submit actions. Unbracketed large still
costs 455.136 ms / 10000 renders: mode negotiation remains essential.
Separate accumulation-only sample, 800000 UTF-16 units in 256-unit chunks:
installed Pi StdinBuffer **526.865 ms**, new runner **0.890 ms**, both one event
and exact content. Reproduce both using `tools/e2e/tern-paste-bench.mjs`.
These measurements do not establish host paint latency or a speed ratio vs OMP.

Real-validation progress remains the installed-OMP PTY and isolated native
Tern startup checks below. A full visible-draft latency comparison is still
unverified. No private clipboard, global installation or user window changed.
For review, start a new runner from the isolated worktree and paste synthetic
CRLF/tab/Unicode/multiline/large fixtures; do not use `/reload` as activation.
The worktree changes remain uncommitted and are not globally activated.

Additional real-transport check: `python3 tools/e2e/tern-paste-pty.py` passed
four fixtures through a real PTY, streaming UTF-8 decoder, new router and real
bridge (fake session; no provider). Writes are 17-byte fragments. Exact draft,
one paste render and zero sends were asserted for 11/10000/20/33 UTF-8 bytes;
observed draft-response times 2.414/32.014/2.199/2.519 ms. Includes PTY writes,
process scheduling and JSON response, not host painting. The initial harness
incorrectly counted asynchronous startup renders; a trace proved 10000-char
content exact with one operation render and three total renders. The checked-in
harness counts the operation delta, not the startup total.

## Provenance and scope

Baseline: Trebol `2de69785a3a6739e46a832c4233ce07a184bbd68` (PR #361
branch left untouched). Worktree: `/home/robert/trebol-362-paste`, branch
`fix/362-chat-paste`. No MCP/hoja-mode changes, installation, merge or PR.

Installed `/home/robert/.local/bin/omp --version` reports `omp/18.12.6`.
Bounded URL extraction from the executable identified
`https://github.com/can1357/oh-my-pi`. The official `v18.12.6` tag resolves to
`45c35e40c46166dc726ccc52f5d27f40f2449f99`; its
`packages/coding-agent/package.json` declares `@oh-my-pi/pi-coding-agent`
18.12.6. Read-only source clone: `/tmp/trebol-362-omp-source`.
Version identity is established; binary reproducibility/build identity is not.
The local `vendor/oh-my-pi` directory was not a populated source checkout.

Fetched and read https://docs.stencil.so/tern/index.md and
https://docs.stencil.so/tern/protocol/surfaces.md before implementation.

## Upgrade protocol

Read `extensions/upgrade-prompt/extension.ts`. No supported slash invocation
was available to this worker; the exact UPGRADE_TEMPLATE instructions were
applied, not a claimed `/upgrade` command execution:

1. Professional practice: separate terminal mode negotiation, input decoding,
   draft insertion and rendering; establish a baseline before changing code.
2. Primary material: official tagged OMP source, installed Pi dependency code,
   Trebol runner/bridge/editor, raw synthetic input, Tern protocol documentation.
3. Methods: bounded source inspection; identical text fixtures; monotonic timings;
   render and submit-action counters; byte-fragmentation and content assertions.
4. Independent check: executable tests assert exact expanded draft, ordering,
   one render and zero sends; the benchmark reports its own preservation check.

Rewritten task: Compare those paste paths, measure delimiter-on/off behavior,
then correct only supported paste negotiation and content preservation. Keep
the original scope, preserve the published branch and do not access the private
clipboard or send synthetic prompts to a model.

## Source comparison before implementation

OMP source links below are pinned to the verified tag commit:

- [terminal.ts](https://github.com/can1357/oh-my-pi/blob/45c35e40c46166dc726ccc52f5d27f40f2449f99/packages/tui/src/terminal.ts),
  lines 1211–1212 and 2365–2366: enables/restores DEC 2004. Lines 1758 onward
  route completed paste as one event. It also has mode-reassertion/recovery
  mechanisms not implemented here.
- [stdin-buffer.ts](https://github.com/can1357/oh-my-pi/blob/45c35e40c46166dc726ccc52f5d27f40f2449f99/packages/tui/src/stdin-buffer.ts),
  `consumePasteChunk`: chunk array, short terminator-overlap window, one final
  join; timeout and byte-limit recovery. The installed Pi StdinBuffer instead
  appends to `pasteBuffer` and rescans it on each chunk (potential quadratic
  work). This patch does not change that dependency.
- [editor.ts](https://github.com/can1357/oh-my-pi/blob/45c35e40c46166dc726ccc52f5d27f40f2449f99/packages/tui/src/components/editor.ts),
  `handlePaste`/`sanitizePastedText`/`storePasteMarker`: bulk insertion, optional
  large-paste interception, marker above 10 lines or 1000 chars; CRLF/NFC
  normalization, tab expansion and control filtering. Trebol does not copy
  those extra text transformations.
- [input-controller.ts](https://github.com/can1357/oh-my-pi/blob/45c35e40c46166dc726ccc52f5d27f40f2449f99/packages/coding-agent/src/modes/controllers/input-controller.ts),
  lines 2380–2485: macOS file URLs first, then overlapping text/image reads
  while retaining image precedence, target checks and requestRender. Trebol's
  Ctrl+V path reads file paths, image, text serially. That path was not optimized
  or timed with the real clipboard, and is not evidence of the reported delay.

Trebol runner `.pi/lib/tern/run.ts` used StdinBuffer but never enabled DEC
2004. A terminal not already in that mode sends plain keys; each printable
key goes through `appendDraft` and `#editDraft` to `#render`. Embedded returns
can become submit actions. This is a demonstrated synthetic mechanism, not a
measurement of the user's terminal's initial mode. Bracketed text already took
one paste callback and one render. `pasteText` nevertheless flattened short
multiline text. `swarm-image-paste` is Windows-only and not involved here.

## Measurements

Command: `node --experimental-strip-types tools/e2e/tern-paste-bench.mjs`.
Node 22.23.3, seven trials, median milliseconds; 256 UTF-16-unit chunks,
empty fake session, real Pi StdinBuffer and real PiTernBridge, no terminal or
model. Endpoint: synchronous draft edit and render callback completed, **not
visible host painting or TSP acknowledgement**. Submit actions are counted
without executing them. Fixture sizes are UTF-16 units, not bytes.

| Fixture | Size | Baseline unbracketed ms / renders | Baseline bracketed ms / renders | After bracketed ms / renders |
| --- | ---: | ---: | ---: | ---: |
| small | 11 | 1.029 / 11 | 0.262 / 1 | 0.160 / 1 |
| large | 10000 | 458.751 / 10000 | 0.174 / 1 | 0.228 / 1 |
| multiline | 18 | 0.496 / 16 | 0.101 / 1 | 0.124 / 1 |
| unicode | 400 | 9.017 / 400 | 0.070 / 1 | 0.148 / 1 |

The performance change is choosing the bracketed route, **not speeding up an
already bracketed paste**. Timing jitter between bracketed runs is not a
regression claim. Unbracketed multiline generated two submit actions and lost
newlines; baseline bracketed multiline also lost newlines but did not submit.
All post-change bracketed fixtures retain content and have zero submit actions.
The separate installed-process check below is not a measured speed ranking.

### Installed OMP PTY check

`python3 tools/e2e/omp-paste-pty.py` launches the installed 18.12.6 binary in
an isolated HOME and 120x40 PTY, without credentials, extensions, rules, skills,
tools or session persistence. A temporary config skips onboarding and disables
the large-paste menu. It sends bracketed synthetic input, never Enter, clears
only its own draft between fixtures and terminates only its own child.

Observed first-output latency (one sample each): small 5.354 ms; large 21.978 ms;
multiline 3.900 ms; Unicode 6.112 ms. Output contained the expected chat text,
three separate lines, intact Unicode and a `#1 / 10000 chars` attachment for
the large paste. Runtime `handleLargePaste` stages a text attachment below the
menu threshold, so the base editor marker is not always the visible result.

These are **first PTY output**, not time until a painted or fully usable draft.
The probe asserts representative output tokens, not complete content roundtrip.
No synchronized-frame markers were emitted in this terminal configuration;
zero counted markers does not mean zero renders. Internal OMP render counts
remain unknown. The Pi benchmark's render callbacks and OMP's PTY output are
different endpoints and cannot support a comparative speed ratio.

A second installed-OMP run with output assertions passed all four fixtures:
5.178 / 6.928 / 3.839 / 6.225 ms respectively. This variation reinforces that
the samples are not a stable performance estimate. No input contained Enter
outside the bracketed payload; no model credentials were provided.

Headless visual investigation: started a separate `tern serve` with config,
output and control socket under `/tmp/trebol362-visual`. Its `.sf-dock` showed
OMP's native chat. `ctl paste` was rejected as unknown; `tern send` could not
reach this headless server through its isolated daemon socket (none existed).
The discovered `clipboard` scenario command was not used because clipboard
isolation was not established. Thus this check proves startup only, not paste
latency or rendered content. No user's window was controlled or closed.

## Implementation and validation

- `paste-mode.ts`: idempotent DEC 2004 enable/disable, activated only after a
  successful Tern connection and restored on close. Native fallback untouched.
- `run.ts`: owns that mode and uses streaming UTF-8 decoding across stdin reads.
- `bridge.ts`: multiline composer pastes use existing markers even when short;
  expanded text preserves newlines (CRLF still normalizes to LF). Modal/picker
  behavior remains unchanged. No automatic submission added.
- Tests exercise one-byte chunking, split delimiters/UTF-8, prefix/suffix order,
  content, no send and one render; clipboard mock test checks newline retention.

Passed: `npm run build:runtime`; focused 47 tests; full
`npx --no-install vitest run .pi/test/tern` — 29 files / 367 tests.

## Activation and limits

Not installed or activated in existing sessions. To try this branch, start a
new Tern Pi runner from this worktree using
`node --experimental-strip-types .pi/lib/tern/run.ts`. `/reload` does not
replace the loaded runner module. Keep this worker tab open.

Still unverified: installed OMP versus Pi end-to-visible-draft latency, live
host paint/render counts, terminal mode resets, and very large paste behavior.
This work does not claim to solve Pi's chunk accumulation complexity or the
existing TSP splitter's treatment of protocol-shaped bytes within pasted text.
