# Collapsed work and composer: ambitious redesign checklist

First fetch the current documentation index: https://docs.stencil.so/tern/index.md.
Follow its live design, component and input-protocol links before implementing.

## Collapsed work is an information architecture problem

Before editing, trace `.pi/lib/tern/turn-groups.ts`, `work-summary.ts`, group view
state and work nodes in `bridge.ts`, `work-style.ts`, the running-work store,
and work/turn-group tests. Distinguish completed transcript groups from active
foreground execution and detached background work; collapsing changes none of
their semantics.

Design three useful levels rather than a binary wall-of-output switch:

1. **Glance:** purpose, real status, active action, completed/failed counts,
   elapsed time when known, and an unmistakable expand affordance. Avoid
   repeating the same labels. A failure or request for attention stays visible.
2. **Inspect:** a compact activity timeline with meaningful step labels,
   active work, latest completed results and persistent failure rows. Offer
   All / Active / Failed filters only when they help and have real data.
   Search is valuable for large histories; preserve selection across updates.
3. **Deep detail:** selected-step output, parameters safe to display, error,
   exit status, cancellation/timeout distinction, relevant artifacts and links.
   Keep large output bounded with an explicit way to open/read more. Never
   silently claim the truncated view is complete.

Evaluate native trace/tool/list/table/card primitives rather than accumulating
text chips and custom CSS. Inline expansion is often better than a forced modal
for ordinary reading; an optional inspector can support deep work without
turning every click into a context switch. Show alternatives before deciding.

Persist the user's fold choice within the correct turn/session identity.
Streaming updates must not remount the whole group, move focus, repeatedly
expand it, or erase native scroll position. New failures should become visible
without unexpectedly unfolding all successful history. A status change is not
authorization to discard a user's chosen view.

Do not add Retry unless the underlying operation is genuinely retryable with
clear side-effect semantics. Do not label Stop as Cancelled until the runtime
confirms it. Never infer task completion from an assistant's summary sentence.

## Composer is the control surface, not just a textarea

Inspect `draft-edit.ts`, `composer-view.ts`, keyboard routing in `run.ts` and
`bridge.ts`, autocomplete, attachments, queue rendering and native edit events.
Preserve existing draft/caret/selection/undo and model submission semantics.

Proactively look for:
- Clear distinction between Send, Steer, Queue and Stop; disabled explanations.
- Pending-message visibility and edit/restore/remove affordances with honest
  ownership and exactly-once delivery.
- Attachment previews, per-item removal, paste handling and upload/error states.
- Useful, discoverable shortcuts; no global hotkeys firing while a nested prompt
  owns input; Escape closes only the innermost interaction.
- Growing multiline input without crowding the transcript; no clipping on small
  panes; accessible labels and clear focus when returning from an inspector.
- Slash/mention autocomplete that neither destroys a draft nor sends accidental
  partial commands. IME composition and native edit/undo must remain correct.

## Acceptance scenarios

Render and interact with: zero work; one running call; simultaneous calls;
completed successful turn; one failed call among many successful ones; blocked
or waiting state; timeout; cancellation; restored history; hundreds of steps;
large output; narrow pane; long Unicode names; a collapsed group receiving new
events; an expanded selection receiving new events; another session replacing
the current one; a half-typed draft while opening and closing details.

Record what became faster or clearer: glanceable failure detection, fewer
expansions to reach an error, preserved scroll/fold state, or no lost composer
input. Prefer measured interaction improvements to feature count.

## Verified native layout lesson

Background output formatting belongs in a bounded presentation adapter, not the
runtime state reducer. ANSI styles, diagnostic wording and JSON fields never
determine task status. Preserve only safe SGR, remove OSC/APC/DCS controls, handle
carriage-return progress updates and retain sanitized raw text. Agent projection
must skip reasoning/runtime scaffolding and key messages by persisted entry IDs,
not their index in a moving tail. Label truncated windows and unavailable files.
Pause viewing freezes output while the runtime continues; Stop remains pending
until an authoritative state change. Native screenshots are needed to catch
duplicated diagnostics and disappearing status columns.

Tern table columns with LOWER `priority` hide first. Set the main grow/name
column to the highest priority explicitly. A default priority of zero on the
step name and priority two on Outcome hid every step name on a 480px pane,
leaving indistinguishable result rows. Node tests passed; native screenshot
inspection caught it. Verify both identity and outcome remain discoverable in
the narrow layout (the selected-step detail can retain secondary columns).

The current implementation's inline All/Active/Failed filters and overlay search
are separate: search lives in the inspector, not in every transcript group.
Full argument dumps are intentionally absent; only safe recognized metadata is
summarized. Artifacts remain in the original step, reached by Reveal original
step. Do not claim an artifact gallery or arbitrary-argument inspector exists.
