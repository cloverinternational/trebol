/**
 * The `/context` card's own styles. Tern lays out the overlay, the meter and the text nodes, so this only
 * aligns the two numeric columns and quiets the note and the hint.
 *
 * Stick to the selector subset Tern supports (docs/reference/tern-site/styles/css.md): no `:has()`, no `~`
 * combinator, and no leading region element — a program sheet is prefixed with `[data-scope]`.
 */
export const PI_CONTEXT_CSS = `
[data-role='pi.context.tokens'],
[data-role='pi.context.share'] { text-align: right; white-space: nowrap; }
[data-role='pi.context.room'] { color: var(--t3); }
[data-role='pi.context.note'],
[data-role='pi.context.hint'] { font-size: calc(var(--sf-fs, 13px) * 10.5 / 13); color: var(--t3); }
[data-role='pi.context.hint'] { margin-top: 2px; }
`;
