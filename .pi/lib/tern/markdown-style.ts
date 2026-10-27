/**
 * Theme-neutral Markdown callouts. Tern tints `> [!NOTE]`-style callouts with the theme's `--accent`, so every
 * theme repaints them (pink on cyberpunk, orange on coral). Here a callout is a hairline rule plus a quiet
 * icon on the page background; only warning and caution keep `--warn`, on the rule and icon.
 *
 * Measured in headless Tern 0.9.5 (ideas/tern-markdown/): the callout fill went from 16–20 RGB off the page
 * to identical with it under dark-cyberpunk, light-coral and light-cyberpunk. Selectors follow the
 * documented `md` contract (docs/reference/tern-site/elements/text.md) and the subset in styles/css.md.
 */
export const TERN_MARKDOWN_CSS = `
.sf-md .callout { background: transparent; border: 0; border-left: 2px solid var(--l3); border-radius: 0; }
.sf-md .callout .co-ic { color: var(--t3); }
.sf-md .callout.warning,
.sf-md .callout.caution { border-left-color: var(--warn); }
.sf-md .callout.warning .co-ic,
.sf-md .callout.caution .co-ic { color: var(--warn); }
`;
