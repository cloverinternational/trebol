/**
 * The work card's own styles. Tern draws every step head (`tool`, muted/strong/path/command spans, the
 * half-second timer, the spinner) from its built-in sheets, so this only styles the few things the bridge
 * contributes: the one Inspect affordance, the tracked-task line, and the rule that the card head owns the
 * glyph while its steps are named by verb and target.
 *
 * Stick to the selector subset Tern supports (docs/reference/tern-site/styles/css.md): no `:has()`, no `~`
 * combinator, and no leading region element — a program sheet is prefixed with `[data-scope]`.
 * Font sizes are `calc(var(--sf-fs, 13px) * N / 13)` so they follow the terminal font with or without Tern's
 * region zoom (see composer-style.ts).
 */
export const TERN_WORK_CSS = `
/* The card head carries the turn's glyph; a step is a verb and a target, never the same icon again. */
[data-role='tern.work-body'] { margin-top: 2px; }
[data-role='tern.work-body'] .sf-tool-ic { display: none; }
/* Active work is not a warning. Tern paints a running tool card with its theme's live colour and pending
   tint; in imported palettes those come out orange, so the turn's own live card overrides both to quiet
   neutral. Motion stays (the spinner still turns), and a step's error tint is untouched. */
[data-role='tern.work-live'].sf-tool.card.st-running,
[data-role='tern.work-live'].sf-tool.card.st-pending {
  --live: var(--t2);
  --sf-tint-pending: transparent;
  background: transparent;
}
/* The tree is read by depth: each step sits clearly inside the card, with no rails or rules to say so. */
[data-role='tern.work-body'] .sf-tool { padding-left: 18px; }
/* A step's own body sits one level further in, so the tree reads as card > step > output. */
[data-role='tern.work-body'] .sf-tool-body { padding-left: 12px; }
/* The one affordance in the tree: quiet text, no pill, no border, no background. */
[data-role='tern.work-inspect'] { color: var(--t3); font-size: calc(var(--sf-fs, 13px) * 10 / 13); letter-spacing: 0.02em; }
[data-role='tern.work-inspect']:hover { color: var(--t1); }
[data-role='tern.work-focus'] { color: var(--accent); font-size: calc(var(--sf-fs, 13px) * 11 / 13); }
`;
