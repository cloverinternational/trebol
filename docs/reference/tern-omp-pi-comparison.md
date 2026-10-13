# Tern / OMP / trebol TSP comparison

Scope: read-only research. Compares trebol's `.pi/lib/tern` bridge with the Tern SDK docs in `docs/reference/tern-sdk` and the installed OMP v18.9.1 bundle. No bridge code was edited and no prompts were run.

## Live OMP wire baseline (added after source-only research)

An isolated Tern 0.6.2 pane ran OMP 18.9.1 with
`PI_TUI_TSP_RECORD=/tmp/trebol-omp-tsp-baseline.jsonl`. The recording
contained an `o` frame opening `{mode:"inline", role:"omp.session"}` and
five initial `f` frames; no model prompt was sent. A bounded structural
inspection (excluding transcript text) found frame 1 adding empty `main`,
`dock`, and `layer` roots. Under `main` OMP added a welcome `card`, spacers,
and a tip. Under `dock` it added **one `col` with role `omp.editor`**, in
this exact order:

1. `meter` role `omp.composer.context` (`style:"bar"`, `total`, tooltip).
2. `row` role `omp.composer.line` containing the focused `editor`.
3. `row` role `omp.composer.bar` containing model selector row, transparent
   extras `status` (Git `seg` when available), usage text, and send `kbd`.

The observed Tern capture of this OMP pane showed the welcome and update
notice, but `tern capture --surfaces` documents that it includes only the
surface **main** text. It therefore does not independently prove the dock's
pixels. The recording proves emitted node structure, not visual match.

Current Pi emits separate `header` status, `editor`, and `status` siblings in
`dock` (`bridge.ts#dock`). This is the concrete layout divergence to fix.
OMP has builtin logo, model selector action and Git chip that require
capabilities/data not yet provided by Pi's bridge. Do not invent them.

## Pi structural update and result

The later Pi patch changed `tsp.ts` to emit `main`, `dock`, and `layer` roots,
and `bridge.ts` to emit one `pi.editor` dock column: optional context meter,
composer editor row, and model/status/send bar. `/commands` now opens a
non-modal overlay in `layer`, anchored above the editor. Replay-based tests
check roots, order, focus, picker placement/removal and close behavior.
These are analogous **node roles and regions**, not copied OMP styling or
complete feature parity. Pi does not expose an OMP wordmark/logo, clickable
model selector, Git chip, image blob path, or extension approval UI here.

The side-by-side live check launched OMP 18.9.1 and bare `pi` in separate
Tern 0.6.2 panes. OMP's recorded initial wire tree proves its welcome card
and composer structure; Pi's live `/commands` still appeared in the main
transcript after its structural patch. Tern's CLI `capture --surfaces`
includes **main** text only, not `dock` or `layer`, so the dock's actual
visual appearance and the overlay's pixels were not verified by that
capture. A model prompt, tool stream, approval dialog, cancellation and
resize were not compared live. Calling the result “OMP 1:1” would be false.

## Styling follow-up

Inspection of the installed Tern 0.6.2 binary's bounded CSS strings found
OMP-only selectors, e.g. `[data-role='omp.editor']` makes a rounded, glassy
composer with 12px side margins, 11px/14px padding and a 16px radius;
`omp.composer.context` floats the meter above its top edge; and
`omp.composer.bar` adjusts spacing. Pi uses honest `pi.*` roles, so those
OMP selectors did **not** apply even when the node tree matched. Pi now sends
its own surface-scoped TSP `s` sheet (`composer-style.ts`) after opening the
surface and before the first frame, targeting `pi.editor`,
`pi.composer.context`, `pi.composer.line`, and `pi.composer.bar`. This copies
the observed structural styling values without claiming OMP identity or
installing global Tern CSS. A live Pi pane still parsed and listed
`/commands` after this addition; no screenshot/control-tree comparison of
the actual composer pixels was obtained, so visual 1:1 remains unverified.

## Harmless-turn transcript baseline

A second OMP 18.9.1 Tern pane recorded one harmless reply using
`PI_TUI_TSP_RECORD=/tmp/trebol-omp-turn.jsonl`. Structural inspection only
(no transcript text in the analysis) found `omp.user` as a `card` of `tone:
"user"` holding the prompt `md`, followed by `omp.assistant` as a `col`;
its Markdown child was added in a later frame and grew with `text append`
ops. The installed Tern 0.6.2 CSS applies `omp.user` and `omp.assistant`
role-specific spacing, so generic Pi `md` rows were visibly a different
composition even after the composer patch. Pi now projects a `pi.user`
card and `pi.assistant` col with stable nested Markdown child, preserving
append semantics, and uses a surface-scoped Pi stylesheet for equivalent
observed spacing. A focused test asserts a growing assistant reply emits
only `text append` for the nested child.

A live Pi pane after this patch accepted `Reply exactly: PI_LAYOUT_OK`;
`tern capture --surfaces` showed the user prompt and final `PI_LAYOUT_OK`
once. This verifies readable main-region text and a provider turn, **not**
matching card pixels, dock styling, tool rendering, approval controls or
full OMP behavior. The dedicated pane was closed after observation.

The recording does **not** establish tool card chrome, approval overlays,
model selector behavior or identical pixels. Native live screenshot/tree
comparison is still outstanding. Do not equate an analogous node hierarchy
with 1:1 OMP rendering.

Tern's documented `cx.session:surface(pane)` window-plugin API can read the
`main`, `dock` and `layer` **node tree** for a pane
(`tern-site/reference/api-window.md:864-871`), unlike `tern capture
--surfaces`, which reports main text only. A future focused diagnostic
window plugin could compare these live trees without exposing transcript
content. A separate developer control window created for this audit attached
to a different session/window; its `tree` selector returned zero matches for
the intended OMP pane, so its result is **not** evidence of a visual match.

## Evidence grades
- **A**: read directly in a local file, with exact line or byte offset.
- **B**: read in docs, but not checked against running code.
- **C**: inferred. Not verified.

## Sources
- OMP package: `/Users/swarm/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` (`package.json` version `18.9.1`, A). `~/.bun/bin/omp` symlinks to `dist/cli.js`.
- OMP bundle: `dist/cli.js` is minified, 62,310 lines, with 999 lines over 2000 chars. Citations use `line` plus byte offset. Excerpts are bounded.
- Tern SDK docs: `docs/reference/tern-sdk/api/tern.d.luau`, `pages/typescript/README.md`, `pages/go/tern/README.md`.
- trebol: `.pi/lib/tern/tsp.ts`, `.pi/lib/tern/bridge.ts`.

## Result

1. **Regions.** Tern defines three regions: `main`, `dock`, and `layer`. `tern.d.luau:265-268` (A) documents `dock` as "under the main area" and `layer` as "above the main area". `pages/typescript/README.md:93` (B) gives `{ main?, dock?, layer? }`. OMP's reconciler iterates over `["dock","layer"]` at `cli.js:1887` (byte 15787413, A) and creates `main`, `dock`, and `layer` roots (`cli.js:1887`, byte ~15787191, A). trebol only emits `main` and `dock` (`tsp.ts:212-214`, `tsp.ts:282-285`, A). Pickers are placed in `dock` (`bridge.ts:320-355`, A), not in `layer`.

2. **Node kinds.** `cli.js:1334` (A) contains a kind vocabulary including `"editor","input","status","seg","overlay","toast","rows","picker"`. trebol uses `editor`, `status`, `seg`, `col` (`bridge.ts:325-353`, `tsp.ts:282`, A). The vocabulary is OMP-side and was not checked against the wire spec.

3. **Editor.** trebol sends `{id:"composer", k:"editor", p:{text, placeholder, sendable:false}}` (`bridge.ts:325-333`, A). OMP's editor props include `placeholder`, `readonly`, `maxLines`, `mode`, and `lang` (`cli.js:2029`, byte ~16270786 area, A). trebol does not send `maxLines` or `lang`.

4. **Header and footer.** trebol's header is a `status` node with `seg` children (`bridge.ts:334-343`, A). Its footer is also a `status` node with id `status` (`bridge.ts:344-353`, A). In OMP, the footer `Q("col",{gap:"xs"},s,"footer")` (byte 17686380, A) belongs to a model-hub overlay. I did not find a general OMP header/footer region on the TSP surface. Grade C for any claim about OMP's main-screen footer layout.

5. **Flow control.** trebol uses `DEFAULT_CREDITS=2` and `APC_LIMIT=65536` (`tsp.ts:9-10`, A). It parses credits from the hello reply (`tsp.ts:164`, A). OMP has `APC=65536` at `cli.js:1334` (A). OMP has a fallback path, "TSP: terminal stopped acknowledging frames; resuming without credit" (byte 15816386, A). trebol has no equivalent fallback when acks stop (`tsp.ts:218-283`, A).

6. **Close.** trebol's `close(keep)` flushes and sends `x` (`tsp.ts:258-263`, A). OMP's `close()` removes `dock` and `layer` children it owns (`cli.js:1887`, byte 15787413, A).

7. **Overlay nesting.** OMP logs "TSP: overlay nested in a hoisted overlay dropped" (`cli.js:1887`, A). trebol has no overlay or layer concept, so this does not apply yet.

8. **Blobs.** OMP has blob-cache handling (`cli.js:1887`, "could not save a blob", A). trebol has no blob path. Not needed for current scope.

## Gap matrix (priority order)

| # | Gap | trebol | Tern / OMP | Grade | Priority |
|---|-----|--------|------------|-------|----------|
| 1 | No `layer` region | `TspView` only `main` and `dock` (`tsp.ts:212-215`) | Tern API defines `layer` (`tern.d.luau:267-268`) | A | High |
| 2 | Picker in dock, not layer | `#dock()` returns picker first (`bridge.ts:355`) | Overlays belong above main (`tern.d.luau:267`) | A/B | High |
| 3 | No ack timeout fallback | Surface waits for credit forever (`tsp.ts:251-257`) | OMP falls back to non-credit mode (`cli.js:1887`) | A | Medium |
| 4 | Editor missing `maxLines` and `lang` | Only text, placeholder, sendable (`bridge.ts:325-333`) | OMP editor props (`cli.js:2029`) | A | Low |
| 5 | Credits hard default | Default 2 used only if hello omits it (`tsp.ts:164`) | Hello reply supplies credits | A | Low |
| 6 | No blob path | none | blob cache (`cli.js:1887`) | A | Low, out of scope |

## Testable UI changes

1. **Layer for picker.** Add `layer` to `TspView` and `#ops`. Move the picker node from `dock` to `layer` in `bridge.ts:355`. Test: with the picker open, the `layer` root has the picker and `dock` contains only header, composer, and status. Close the picker and check that `layer` is empty.
2. **Layer removal on close.** Test: `TernInlineSurface.close()` removes `layer` when it was added, mirroring OMP's behavior at `cli.js:1887`.
3. **Ack timeout.** Add a test where no ack arrives. Assert the surface sends one final frame and then keeps working, or assert it degrades to no-credit mode. The exact behavior should match the Tern docs at `pages/typescript/README.md:118-119` or the Go spec at `pages/go/tern/README.md:95-100`.
4. **Editor props.** Add `maxLines` to the composer node and assert it appears in the encoded `f` frame.
5. **Frame diff for layer.** Assert that a picker open-close cycle sends `add`/`remove` ops only for `layer`, not `main` or `dock`.

## Issues
- OMP's bundle is minified. Byte offsets are stable for this install but may change if the package is reinstalled.
- I did not run OMP or Tern. Grades reflect source reads only.
- The OMP grep for "tsp" in `src` found no TSP sources, so the TSP reconciler exists only in the bundle (C for source-level details).
