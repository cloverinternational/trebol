# Progressive native Tern work experience

## Agreed scope

User selected progressive inline activity plus an optional inspector. Build an
ambitious collapsed-work upgrade, not merely a documentation example. No subagents.
The repository-local design skill is already created at
`skills/tern-native-experience/SKILL.md`, linked from AGENTS.md, validated with the
project skill loader, and requires fetching https://docs.stencil.so/tern/index.md
for the latest documentation on every Tern UI task.

## Implementation

1. Fetch current Tern design/work/input documentation and inspect the installed
   primitive support. Capture a baseline for collapsed/running/failed work.
   Preserve existing unrelated edits, including concurrent bridge/input changes.
2. Extract a focused pure work-view model/projector where needed, rather than
   adding another large subsystem to bridge.ts. Use actual turn/tool IDs and
   lifecycle events; separate running, failed, timed-out, cancelled and finished.
3. Upgrade collapsed headers with concise purpose, real counts, current action,
   elapsed time when known and an obvious expansion affordance. Failures remain
   noticeable while successful detail is collapsed. No fake progress estimates.
4. Add progressive inline activity: All / Active / Failed views, useful search
   for large groups, meaningful step labels and selection. Keep narration in
   chronological context without overwhelming the activity view. Preserve user
   fold/selection state through streaming, settlement and native redraws; do not
   rebuild keyed groups or auto-scroll a user reading earlier work.
5. Add an optional native selected-step inspector for safe arguments, output,
   errors, exit/timeout/cancel state and available artifacts. Bound large output
   with explicit truncation and recovery affordances. Do not introduce Retry or
   Stop controls unless the owning runtime supports their exact semantics.
6. Improve adjacent composer handoff: opening/closing/filtering work must preserve
   draft, attachments, caret and undo. Route raw keys and native editing/paste
   correctly; Escape unwinds the inner view before returning to chat. Do not
   broaden this task into an unrelated queue or composer rewrite.
7. Provide empty/loading/error/settled states, wide and narrow layouts, keyboard
   and pointer controls, accessible names and native motion. Use semantic Tern
   components and token styling; avoid gratuitous custom CSS.

## Verification

- Tests for empty work, parallel calls, mixed success/failure, timeout/cancel,
  restored history, long labels and large output; filtering/selection and exact
  IDs; stable disclosure on streaming/settlement; session replacement cleanup.
- Bridge tests for real action routing, raw/native input ownership and preserved
  composer state. Existing turn/work/background behavior must remain intact.
- Real native screenshots before/after, wide/narrow and failure states; inspect
  images and native element trees. Exercise a live owned pane if available;
  distinguish fixture rendering from a complete live interaction round trip.
- Run focused and affected Tern suites, appropriate typechecks, style lint and
  diff checks; report baseline failures separately. Update AGENTS.md, changelog
  and the local skill with verified reusable findings.
- No automatic commit/push, no unrelated cleanup or vendor edits. State restart
  requirements and any remaining live-verification limits explicitly.

## Delivery and limits

Implemented inline filters, factual count badges, collapsed current-action
preview, persistent filter/disclosure state, native controls, and a searchable
read-only selected-step overlay. Search lives in the inspector; artifacts stay
on the original step, accessible via Reveal original step. Safe summary metadata
is shown instead of arbitrary parameter dumps. Composer input/paste remains
isolated, and selecting Reveal does not expand other work groups globally.

Verification: 51 Tern test files / 597 tests passed. Native baseline and updated
All/Failed/collapsed/inspector recordings and screenshots are under ignored
artifacts/work-redesign. Inspected wide inline and narrow inspector screenshots;
fixed a real priority bug that hid step names on narrow panes. A physical live
pointer round trip was not exercised. New module typechecking and diff checks
are run separately; existing broader bridge typing/style failures are not
represented as passing. Restart the pane to load runner changes.

Final focused work run: 50 tests passed. New work-inspector module typecheck and
diff checks passed. Style lint recognizes Tern's native 12px small-button scale
instead of overriding native controls; 42 existing type-scale errors and 11
warnings remain in the global recorded-session suite. No blanket lint success
is claimed.
