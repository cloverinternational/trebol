# TREBOL-366 corrections — pending independent re-review

This is an implementation response, **not approval**. The original review is
unchanged at `artifacts/trebol-362-independent-review.md`, SHA-256
`d5bd7e20de6df525dc5c92525a9712ec7780978186e04909825e804e4915cd83`.
Same worktree/branch: `/home/robert/trebol-362-paste`, `fix/362-chat-paste`.
No activation, commit, PR, merge, Hoja writes, MCP changes or user-window changes.

## Upgrade method

Read `extensions/upgrade-prompt/extension.ts` again. No supported slash executor
was exposed; applied its exact UPGRADE_TEMPLATE, not a claimed command invocation.
Professional practice: specify recovery states and ownership before editing;
primary sources: intact independent review, current code and pinned OMP source;
methods: negative tests, controlled clocks, PTY, reference reachability and
same-fixture benchmarks; independent check: failing-before/passing-after tests
and a subsequent independent review, not the implementer's confidence.

Rewritten prompt executed: fix only the three findings with bounded recovery
that cannot execute captured input, positional marker identity and release of
unreachable payloads; preserve exact text and fast bulk insertion; reproduce
negative cases first; document cancellation ambiguity and performance cost.

## High: incomplete paste

Before fix: negative test feeding opening delimiter + 102400 chars + Ctrl-C/ESC
had no recovery notification after a controlled timeout. Existing report also
establishes unrestricted retention and capture of subsequent keys.

After fix (`paste-input.ts`, `run.ts`): default **8 MiB UTF-8 payload limit** and
**2 seconds inactivity**. Payload controls remain data. At timeout the buffered
partial content is delivered exactly as draft data and input enters quarantine.
At byte overflow the **entire paste is rejected**, with an explicit diagnostic;
no shortened fragment is accepted. Buffers/timers are released. Quarantine
discards all input; a **separate input event containing only Ctrl-C** explicitly
acknowledges recovery, without invoking interrupt or submit. `resume()` is the
out-of-band API equivalent. A control byte while a paste is active is never
treated as cancellation. `cancel()` rejects explicitly; `dispose()` cleans up;
EOF calls `end()` and runner restore clears timers and mode.

Boundary limitation: a delayed payload byte identical to the separate recovery
acknowledgement cannot be distinguished from a user's acknowledgement by this
terminal protocol. User must wait for the notice/transfer to stop before pressing
Ctrl-C. Literal closing delimiters also remain protocol-ambiguous. EOF preserves
the partial draft callback but process shutdown does not persist that draft to
disk. SIGKILL cannot run cleanup. No claim of OMP mode-reassertion parity.

## Medium: marker collision

Before fix: `insertPaste('a\nb'); marker=text; setText(''); insert(marker)`
expanded the literal marker to the old payload. Negative test failed as expected.

After fix (`draft-edit.ts`): actual inserted spans carry start/end and payload;
expansion walks these spans, never a regex over arbitrary text. Undo snapshots
carry span identity. `setText` creates literal text, even for identical marker
spelling. Edits shift spans; overlapping edits invalidate the edited span's
identity rather than assigning identity to text. Whole-marker backspace uses
the actual span. A literal copy remains literal beside a real token and through
undo. Partial editing of a marker intentionally turns its remaining spelling
into literal text; undo can restore the original token.

## Medium: retention

Removed lifetime payload/marker maps. Payload strings are referenced only by
current spans and up to 200 undo snapshots. Evicted snapshots are collectible.
Repeated 300 distinct payloads plus clears retain at most 100 payloads in this
test pattern; disposal retains zero. `close()` disposes the editor; `rebind()`
clears old undo history while preserving the visible draft, matching existing
session-continuity behavior. Queued/submitted messages use expanded strings and
do not depend on marker maps. There is no redo implementation to preserve.

This bounds historical operation count, not aggregate heap bytes. Current draft,
queue strings and up to 200 large undo states can still consume substantial
memory. No heap-exhaustion test or global draft byte budget is claimed.

## Verification and measurements

- Before production edits: `vitest run .pi/test/tern/paste-review.test.ts`:
  three failures (collision, absent retention API, absent timeout recovery).
  The retention test's initial failure alone is not a heap measurement; the
  lifetime maps in source and independent review establish that defect.
- After: `npx --no-install vitest run .pi/test/tern`: **31 files / 377 tests**.
  New coverage: timeout, byte-limit rejection, EOF/cancel/dispose, watchdog
  cancellation, repeat after recovery, literal collision, undo and eviction.
  Existing split delimiter/UTF-8/order/no-submit regressions still pass.
- `python3 tools/e2e/tern-paste-pty.py`: four exact fixtures, one paste render,
  zero sends; measured 2.516 / 29.239 / 3.076 / 2.534 ms (transport/process
  overhead, not host painting).
- Additional real PTY probe: partial `abc\r` + Ctrl-C/ESC timed out into exact
  paste data; `\rAFTER` in quarantine produced no key; separate Ctrl-C then `OK`
  produced only key `OK`. No clipboard/model/other window used.
- Comparable accumulation fixture: 800000 UTF-16 units, chunks 256, same
  `tools/e2e/tern-paste-bench.mjs`: before new router 0.734 ms; after 4.150 ms.
  Installed Pi parser in those runs: 592.338 and 500.429 ms. The increase is
  real watchdog/byte-accounting overhead; measurements are individual samples,
  not a statistical claim. Exact output, one event in all runs.
- `git diff --check` passed; review SHA-256 unchanged after tests.

## Review and activation

Run the full Tern suite and both checked-in benchmark/PTY scripts from the
worktree. Inspect `paste-review.test.ts` alongside `paste-input.ts` and
`draft-edit.ts`; then perform a new independent review before activation.
No global checkout was changed. Starting a new runner from this worktree is
required to test integration; `/reload` does not replace the runner module.
Host paint latency, real clipboard behavior and abrupt terminal loss remain
unverified. Worker tab and the earlier isolated lab server remain open.
