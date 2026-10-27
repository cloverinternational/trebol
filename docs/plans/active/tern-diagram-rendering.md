# Tern diagram and table rendering

## Scope and decision

Improve existing Mermaid, SVG, diagram and Markdown table rendering, not the
surrounding application. User approved necessary Tern host fixes when a defect
belongs there. Preserve all existing local edits. Do not edit vendor references.

## Evidence collected

- Installed OMP pi-tui 18.9.1 uses native `md` nodes for assistant Markdown
  (`src/chat/assistant-message.ts`); Mermaid ASCII is a separate terminal path.
- Trebol `.pi/lib/tern/tsp.ts` `projectTranscript` already passes original
  Markdown and streaming state to native `md` nodes.
- Tern 0.9.5 owns Mermaid layout, Markdown tables and SVG sanitization.
  Official `elements/text.md` documents provisional fences, natural diagram
  sizing, horizontal scrolling and Open. `elements/data.md` documents SVG's
  256 KiB cap, required viewBox or width/height, sanitization and image zoom.
- `extensions/auto-graph/extension.ts` supplies `details.plan` and `details.tsp`
  as well as an ASCII fallback. Bridge inspection indicates only the fallback
  reaches the transcript; verify this with a failing regression test.
- `.pi/lib/tern/artifact-previews.ts` sends bounded original SVG bytes as
  content-addressed blobs before image nodes. Do not bypass host sanitization.

## Implementation sequence

1. Locate the active Tern host source and read its local instructions; record
   source versions. Trace Markdown parsing, Mermaid layout, SVG loading and
   table sizing to their actual owners. If host source or build tooling is
   unavailable, document that blocker rather than patching an unrelated copy.
2. Build a small deterministic fixture harness using the real Trebol bridge
   and native Tern surfaces, without a model. Include a labeled flowchart and
   sequence diagram, an incomplete and malformed Mermaid fence, a sized SVG
   and unsupported SVG content, and an aligned wide table with inline code.
   Capture baseline screenshots and native tree/layout diagnostics at narrow
   and wide widths and supported light/dark themes. Compare OMP's native
   projection with identical inputs; avoid conflating its ANSI renderer.
3. Turn demonstrated failures into regression tests before fixing them.
   Restore the existing auto-graph native rendering path if reproduced,
   validating its data and preserving the non-Tern text fallback and replay.
   Do not blindly execute arbitrary custom-message node payloads.
4. Fix demonstrated rendering defects at the correct layer: bridge props,
   scoped supported styles, or host renderer code. Preserve original Markdown,
   node identity and append updates. Keep host sanitization, blob bounds and
   error fallback intact. Do not add a parallel diagram engine or expand the
   chart planner merely to match OMP's larger feature set.
5. Run focused regression suites plus relevant existing Tern suites. Repeat
   fixture captures and measurements with the same inputs and settings.
   Update relevant architecture documentation only where behavior changes.

## Acceptance criteria

- Finished diagrams show all expected fixture labels and connectors, without
  clipped content; wide content remains reachable through native scroll/Open.
- Incomplete streamed Mermaid remains provisional code until ready; malformed
  input leaves usable source/error feedback rather than breaking the surface.
- SVG aspect ratios remain correct; supported content remains visible and
  unsupported input does not silently masquerade as a verified full rendering.
- Tables preserve values, alignment and inline formatting, with wide columns
  reachable rather than lost. Do not convert Markdown tables to lossy UI tables.
- Existing chart messages render their validated structured data in Tern while
  retaining fallback text outside Tern and avoiding duplicate output.
- Updates retain stable identities; source content and security boundaries do
  not change merely to make screenshots look correct.

## Independent verification and deliverable

Use original fixture expectations, protocol/structure assertions, measured
native geometry where exposed, host renderer tests and before/after screenshots.
OMP and official SDK documentation are external references, not correctness
oracles. Inspect screenshots rather than merely generating them. Report exact
files changed, tests run, visible results, and host/build or theme coverage gaps.
Do not claim browser DOM measurements if only native diagnostics are available.
