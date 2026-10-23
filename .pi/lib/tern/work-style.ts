/**
 * The work card's own styles. Tern draws every step head (`tool`, muted/strong/path/command spans, the
 * half-second timer, the spinner) from its built-in sheets, so this only styles the small amount of text the
 * bridge itself contributes: the group's control chips, its heading, and the compact activity lines.
 *
 * Stick to the selector subset Tern supports (docs/reference/tern-site/styles/css.md): no `:has()`, no `~`
 * combinator, and no leading region element — a program sheet is prefixed with `[data-scope]`.
 */
export const TERN_WORK_CSS = `
[data-role='tern.work-controls'] { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
[data-role='tern.work-mode'],
[data-role='tern.work-collapse'] {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border: 1px solid var(--l2);
  border-radius: 999px;
  background: var(--l1);
  color: var(--t3);
  font-size: 10px;
  line-height: 1.6;
  letter-spacing: 0.02em;
  white-space: nowrap;
  cursor: pointer;
}
[data-role='tern.work-mode']:hover,
[data-role='tern.work-collapse']:hover { color: var(--t1); border-color: var(--accent); }
[data-role='tern.work-focus'] { color: var(--accent); font-size: 11px; margin: 0 0 8px; }
/* Rhythm: one step per line of thought, so steps sit apart instead of stacking into a wall. */
[data-role='tern.work-live'] .sf-tool-body > .sf-tool + .sf-tool,
[data-role='tern.work'] .sf-tool-body > .sf-tool + .sf-tool { margin-top: 10px; }
/* The run box carries a command, its output and a state foot: three things want three gaps. */
[data-role='omp.run'] { margin: 6px 0 2px; }
/* A patch draws its hunks: keep them off the head and off the next step. */
[data-role='tern.work-patch'] { margin: 6px 0 2px; }
[data-role='tern.work-patch.diff'] { margin-top: 4px; }
[data-role='tern.work-latest'],
[data-role='tern.work-failed'],
[data-role='tern.work-overflow'] { color: var(--t3); font-size: 10.5px; margin-top: 4px; }
[data-role='tern.work-preparing'] { color: var(--t3); font-size: 10.5px; margin-top: 4px; }
`;
