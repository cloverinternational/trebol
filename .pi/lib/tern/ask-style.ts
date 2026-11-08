/**
 * The ask flow's own surface. Tern draws the card, its head, the option list and the chips; this only feeds
 * the card's fill, because the ask dialog is a form the user has to read and answer and Tern's `.sf-card` is
 * glass: `--sf-card-bg` is white 55% in light and white 2.8% in dark, which is right for a transcript block
 * and wrong here — in a dark theme the question and the panel behind it were the same colour.
 *
 * Setting the token, rather than the `background` property, keeps Tern in charge of the rest of the recipe:
 * a tone fill still resolves through `var(--sf-tint-*, var(--sf-card-bg))`. `--card` is the kit's opaque card
 * fill and `--fog` is documented as an "opaque soft fill", so either keeps the dialog solid
 * (docs/reference/tern-site/styles/variables.md). `--page` and `--panel` are deliberately absent from the
 * chain: the same table marks both translucent in glass windows, which is exactly where a dialog must not be.
 *
 * Scoped to the dialog's role, so no other card in the pane loses its glass. Stick to the selector subset
 * Tern supports (docs/reference/tern-site/styles/css.md): no `:has()`, no `~`, no leading region element.
 *
 * Measured against a real render by tools/e2e/tern-ask-card-surface.mjs, which fails if this goes translucent.
 */
export const PI_ASK_CSS = `
.sf-card[data-role='pi.ask'] { --sf-card-bg: var(--card, var(--fog)); }
`;
