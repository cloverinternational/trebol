# Tern rendering parity: focused repair

## Implementation checkpoint

Implemented Git request-generation guards, Markdown streaming-state propagation,
native framed live work disclosure, and changed-properties-only TSP patches.
Validation: `npx vitest run .pi/test/tern` passed 282 tests in 20 files;
`git diff --check` passed. The Git fixture harness passed during the Git repair.

Isolated Tern headless probe: collapsed live card measured 24px high; clicking
its header expanded it to 251px, and subsequent streamed updates retained the
expanded state. At a 480px viewport the card occupied x=32,width=416. Screenshots
are local ignored evidence under artifacts/tern-parity/serve/serve/live-*.png.
The narrow screenshot was inspected. This fixture accidentally appended prose
to a closing Mermaid fence, so its displayed code is NOT evidence of Mermaid
rendering failure. A later fresh probe exposed no matching nodes; complete Mermaid,
keyboard disclosure, settled click-state persistence and OMP comparison remain
unverified visually. Both owned headless servers were stopped.

Known remaining UX issue: clicking open a live card leaves the separate streaming
tail visible, potentially duplicating narration. Ctrl+O suppresses that tail.
Do not claim complete parity or completion of the visual acceptance criteria.

## Scope and decision

Preserve the compact running-summary/completed-work hiding design (user approved).
Investigate Git modal correctness and Markdown/Mermaid lifecycle, not a new renderer
or a wholesale OMP clone. Preserve unrelated working-tree changes.

## Baseline evidence

- Trebol HEAD: 41a9f106ad17a07905307763fa8f193c9e0aaf9a; working tree has existing changes.
- Installed Tern: 0.8.3 (e2b8656). Local Pi SDK package: 1.0.4.
- OMP vendor directory is empty; recorded gitlink is daf07999c2fee9b22edc7bf8fea1fb6272e0df5e.
  Installed bundled OMP is a binary; source-level equivalence is not established.
- Official Tern index and elements/text.md read during investigation. Tern md
  supports Mermaid figures and Open; stream is false by default and governs
  provisional/incomplete blocks. Do not infer missing diagram support from
  absence of Mermaid-specific Pi code.
- tsp.ts projectTranscript currently emits stream:true for message bodies,
  including finalized/restored content. bridge.ts work-note md lacks explicit
  streaming state. Trace both before changing them.
- bridge.ts showGitDiff checks only closed after its asynchronous read; closing
  the modal or selecting another file does not invalidate that request. Reproduce
  stale completion before fixing. Current render focus also defaults to composer
  outside existing picker/dialog cases; verify Git keyboard behavior live.
- Existing baseline: 28 tests passed across turn-groups, turn-work, auto-graph.
  tools/e2e/tern-startup-card.mjs passed Git fixtures, watcher checks and index
  non-mutation checks. This captures protocol behavior, not rendered pixels.

## Implementation sequence

### Latest approved direction: live activity visible by default

User screenshot shows the core defect: clipped prompt, working label and step
count reveal no action or target. User selected a live activity panel over an
always-visible ledger. This supersedes the one-line default while running.

- Default live view: short authoritative current-task subject (bounded user goal
  fallback, never an invented title), up to three active action/target rows in
  call order, overflow count, latest actual completion and persistent failure
  indicator. No active tool means a neutral preparing-next-action state or bounded
  visible narration, not fabricated tool activity.
- Separate activity, all-steps and minimized presentation states. Minimize is
  respected through subsequent streaming; completed history defaults compact
  unless the user explicitly chose details. Selected details remain reachable.
- Keep explicit Inspect/All steps/Minimize controls, with bottom collapse after
  long output. Active targets must be visible without opening history.
- Improve safe summaries for common tools (filePath alias, patch filenames,
  bounded descriptions and safe command identity where description is absent).
  Do not show arbitrary command arguments, credentials or fabricated outcomes.
- Tests cover parallel activity overflow, out-of-order completions, failures,
  tool-free streaming, preserved minimize/detail state, settlement and session
  reset. Verify screenshots at normal and narrow widths in an isolated Tern
  session using a dedicated daemon socket. A unit-test pass alone does not finish
  this visual refinement.

### Next refinement: understandable work table and local collapse

User chose task summary above a live tool table. Tern's native table explicitly
has no row events or selection (official elements/data.md), so use an interactive
list with aligned columns rather than promise clickable native table rows.

1. Add a pure bounded summary projector: known tool name to plain action,
   safe target from recognized arguments, execution status, and factual result
   label/duration. Unknown tools retain their names. No model calls, arbitrary
   argument dumps, guessed success, or inferred task associations.
2. Render keyed selectable tool rows as aligned status/action/target/result
   columns within the framed work group. Open one selected row's existing
   renderer beneath the list for detailed output; preserve selection while
   results stream. Keep errors explicit and maintain chronological order.
3. Display current TaskManage focus above the active work list when available,
   explicitly labelled current task. Do not retrospectively label old groups
   with today's task. No task available means no invented task row.
4. Observe native toggle events and maintain per-group presentation state so
   a bottom Collapse work control can close exactly its group, suppress duplicate
   live tails when locally expanded, and reveal the corresponding header without
   stealing composer focus during ordinary updates. Preserve Ctrl+O as a global
   override and clear local view state on session replacement.
5. Keep Collapse work reachable after the selected output, not merely above it.
   Explore a sticky header only if actual host support is verified; do not make
   it a prerequisite or introduce an untested scrolling container.
6. Test summary truthfulness, unknown tools, cancellation/error, parallel updates,
   selection stability, repeated bottom collapse/reopen, session switch and Ctrl+O.
   Capture a long output at normal/narrow widths and actually activate bottom
   collapse. Preserve raw output through row disclosure. Rerun the Tern suite.

Acceptance: understandable rows without raw-output clutter; current task shown
only from authoritative state; selected live details stay current; local collapse
works without scrolling to the top and does not collapse unrelated groups.

#### Checkpoint: work table and local collapse (implemented, not visually verified)

Implemented in `.pi/lib/tern/work-summary.ts` (new, pure) and `.pi/lib/tern/bridge.ts`
(`TranscriptProjector` group builder, `toggle`/`select`/`work.collapse` handling, `#currentTask()`).

- Each run of tool steps is one native `list` (`k: "list"`, role `tern.work-rows`) of `item` rows, ids `row-<toolCallId>`,
  with label, detail (target), value (explicit result) and tone. Narration between runs stays as `md` in order.
- Summaries use only recognized argument keys (`path`/`file_path`, bash `description` only, `pattern`/`query`,
  TaskManage operation count). Unknown tools keep their names. Targets are one line, at most 80 characters.
  No model output, no guessed task association.
- The selected row's existing renderer (`toolRow`, expanded) opens beneath its list. Selection is per group and
  survives streaming and settlement; list ids are `<group>-rows-<n>`.
- Current task (`projectTaskView` focus) appears only in the live group, as "Current task · #id subject".
- Per-group fold: native `toggle` events set the group's `collapsed`; the bottom `Collapse work` text
  (`work.collapse=<group>`) closes only that group. An expanded group suppresses the duplicate streaming tail.
- Ctrl+O (`toggleToolOutput`) clears every local fold. `replaceFromSessionBranch` (resume, session_tree, rebind)
  clears them too.

Tests: `.pi/test/tern/work-summary.test.ts` (6) and `.pi/test/tern/work-table.test.ts` (10, including a 500-line
output that stays behind its row, bottom collapse and reopen). Existing assertions in `bridge.test.ts`,
`turn-groups.test.ts` and `turn-work.test.ts` were updated to the row structure; bash renderer checks now select
the row first. Full `.pi/test/tern` suite: 22 files, 298 tests passing (baseline 282). Snapshot replay was not
regenerated; its `workView` helper reads only the live card, not its rows.

Limits, unverified:
- No live Tern render of the list, row alignment, selection highlight, or the bottom control in a window.
  Headless probe not completed: `tern serve --control` answered `state` and quit on an owned socket, but it
  was not given `TERN_DAEMON_SOCKET` isolation, and no fixture pane or screenshot was produced.
- Header reveal after bottom collapse is unknown. The docs define `reveal` only for list items, not tool heads,
  so nothing requests a scroll.
- Focus-theft prevention is by construction (no focus op is emitted by these events); it is not observed live.
- Native `list` click/select routing and `work.collapse` action delivery are verified only against the bridge's
  event contract, not against a live Tern pane.

### Approved-direction refinement: interactive running summary

User selected a subtle framed live header instead of the passive running line.
Use a native collapsible tool node with stable id/key/kind, running spinner,
goal and step metadata, initially collapsed. Keep live narration and tools as
children so click/Enter/Space reveals current work without waiting for completion.
Preserve the existing streaming tail initially. Keep Ctrl+O as the global override.
Change TSP property patches to send changed properties only, avoiding redundant
collapse resets during status/text updates. Test stable identity and absence of
collapse/focus resets across streaming and settlement, plus global expansion.
Update tests that currently equate hidden children with absent children: collapsed
native bodies exist in the document but are not visible. Verify actual host
disclosure and narrow-width rendering before claiming visual success.

1. Add deterministic regression coverage for out-of-order Git reads and
   close/back/session changes during reads. Introduce minimal request identity
   and invalidation at the owning view boundary; preserve read-only Git behavior.
2. Carry actual assistant streaming state into Markdown projection, including
   expanded narration and finalized/restored messages. Test partial Mermaid
   fences, completion, abort, and hide/reveal without modifying original text.
3. Capture identical small fixtures in isolated Pi/Tern and bundled OMP views:
   Git list/diff, expanded/compact work, complete/partial/wide Mermaid. Use
   deterministic inputs, not paid model output. Inspect screenshots and layout
   at normal and narrow widths, keyboard navigation and focus restoration.
   Record host limitations separately from Pi defects. Only add scoped style or
   icon changes when a reproduced gap warrants them; no arbitrary SVG injection.
4. Add focused assertions for each repaired discrepancy; rerun existing suites
   and Git integration harness. Document exact verified behavior and remaining
   host-owned or unavailable parity checks.

## Acceptance

- Old Git reads never reopen a dismissed modal or overwrite a newer selection;
  errors leave usable navigation and no unhandled rejections.
- Finalized/restored Markdown is not provisional; incomplete streaming diagrams
  remain safe, and completed diagrams remain accessible through work reveal.
- Compact grouping remains unchanged; original message content and session
  semantics are not changed by presentation state.
- Visual evidence distinguishes protocol correctness from host rendering;
  no claim of 1:1 OMP parity from binary strings, unit tests, or screenshots alone.
- Existing focused tests and read-only Git fixture harness remain green.

## Boundaries

No vendor edits, live-user pane manipulation, Git writes to the user's repo,
configuration changes, broad frontend rewrite, or new diagram engine. Use owned
isolated panes and temporary Git fixture repositories. Human diagram comprehension
and exhaustive OMP parity remain explicitly unproven unless separately measured.
