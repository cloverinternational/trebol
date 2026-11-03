# Native background command and agent manager

## Direction selected

User chose a compact live shelf plus unified manager. Improve background command
and running-agent UI with parsed, styled output, not terminal text dumps. No
subagents. Follow skills/tern-native-experience/SKILL.md; current Tern index,
design and work-element docs were fetched for this task.

## Architecture and scope

1. Preserve running-work-store as the authority for identity, lifecycle, timing,
   tokens and stop capability. Do not infer completion/failure/progress from log
   wording. Keep foreground work out of the background shelf. Distinguish queued
   from running instead of labeling both running, as the current shelf does.
2. Extract background view/controller/parser modules from bridge.ts where useful.
   Preserve the existing Bash/agent runtime and Pi terminal work browser.
   Reuse bounded transcript reading but improve projection without revealing
   reasoning or raw runtime scaffolding. Check and preserve concurrent edits.
3. Build a compact native shelf with accurate counts, useful assignment/command
   labels, current observed activity, real elapsed/token data and View all.
   Keep the shelf bounded and the composer usable. All overflow is reachable.
4. Clicking an item or View all opens one native manager: searchable work list,
   All/Commands/Agents filters, lifecycle states, selected-item detail and
   Formatted/Raw views. Include retained completed/failed items under the existing
   runtime retention policy, not indefinite new transcript persistence. Preserve
   selection during streaming and clearly show removed/unavailable items.
5. Parse command output conservatively and within byte/line/depth budgets:
   preserve safe ANSI styles in native rendering, normalize carriage-return
   progress updates, identify explicit diagnostic lines for visual emphasis, and
   pretty-print complete valid JSON. Unknown/malformed/mixed output stays readable
   plain text rather than guessed structured data. Raw means original textual
   content with unsafe terminal controls/secrets removed, not arbitrary escape
   sequence execution. Every truncation and parser fallback stays visible.
6. Project agent conversation into stable-ID chronological message/tool steps:
   markdown for user-facing assistant prose, native code/JSON for tool results,
   distinct role/status labels, no hidden reasoning. Preserve the visible meaning
   and chronology; do not substitute invented summaries. Tool-call-only messages
   remain understandable. Show real transcript-read failures separately from
   empty or still-starting work.
7. Add explicit Follow live / Pause viewing. Pause freezes the displayed snapshot
   without pausing the process; resuming follows current output. Do not yank scroll
   or selection while reading. Maintain stable IDs rather than window indexes.
8. Stop is offered only for live items with the runtime capability. Show pending
   stop feedback and wait for runtime settlement before claiming cancelled;
   guard duplicate clicks and handle failure. Inspecting or formatting never
   executes commands/tools. No retry/relaunch behavior is added.
9. Own raw/native keyboard, edit, paste and Escape correctly while modal; preserve
   draft, attachments, caret and undo on return. Refresh only while visible, clean
   up timers/subscriptions, reject stale session work and use lifecycle guards.
10. Design loading/empty/error/removed/completed states, wide/narrow layouts,
    long output and many concurrent items. Native Tern components and semantic
    tones first; no fake telemetry or decorative charts.

## Verification

- Parser tests: ANSI/control sequences, carriage returns, valid/invalid JSON,
  markdown, multiline logs, secrets, huge lines, partial transcript writes and
  tool-call-only entries. Distinguish output formatting from runtime state.
- State/bridge tests: queue/running/settled, selection stability, stop pending,
  follow/pause, filtering, removed work, session replacement, keyboard/paste
  isolation and composer preservation. Retain existing background behavior tests.
- Deterministic native before/after screenshots and native element trees at wide
  and narrow sizes, with command and agent fixtures; visually inspect and iterate.
  Exercise a live owned pane if available; report limits honestly.
- Focused/full affected tests, module typechecks, diff checks and style lint;
  distinguish existing global failures from regressions.
- Update AGENTS.md, changelog and local skill with verified reusable lessons.
  No automatic commit/push, no production commands or actual agent launches for
  fixture screenshots. Restart required for runner changes.

## Verification receipt

Implemented background-format.ts and background-panel.ts, with bridge integration
for manager selection, filtered list, queued/running distinction, recent work,
pause/follow, pending stop feedback and modal input isolation. Formatted command
output uses safe SGR, conservative complete-JSON parsing and diagnostic badges;
agent prose uses markdown with separate tool-result cards and stable entry IDs.
Original terminal-component browser remains intact. The legacy single-item
renderer is retained for comparison/compatibility, not the live manager route.

53 affected test files / 609 tests passed. New module TypeScript checks and diff
checks passed. Five native fixture captures cover baseline, formatted command,
agent wide/narrow, and failed command; screenshots were visually inspected.
Artifacts: artifacts/background-ui. Native physical pointer/real-agent round trip
was not exercised; no real command or agent was launched for fixture captures.
Global style lint remains at 42 errors / 11 warnings, matching the prior baseline.
No blanket style-lint success is claimed. Restart the Tern pane for runner changes.
