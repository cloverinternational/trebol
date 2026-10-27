/**
 * Pi surface styles. The composer carries OMP's omp.editor / omp.composer.* roles
 * (composer-view.ts), so Tern's built-in omp-composer.css and omp-chat-reader.css
 * draw it; nothing here restyles it.
 *
 * Stick to the selector subset Tern supports (docs/reference/tern-site/styles/css.md):
 * no `:has()`, no `~` combinator, and no leading region element — a program sheet is
 * prefixed with `[data-scope]`, so `.sf-main > …` can never match and only buys a
 * `{"ev":"error","sheet":"composer"}` at startup.
 */
export const PI_COMPOSER_CSS = `
.sf-col[data-role='pi.assistant'] { gap: var(--sf-inner-gap); padding: 0 2px; }
.sf-col[data-role='pi.assistant']:last-child .sf-md .md { font-family: var(--sans); }
.sf-card[data-role='pi.user']:not(:first-child) { margin-top: 8px; }
.sf-card[data-role='pi.user'] .sf-md .md { font-family: var(--sans); }
[data-role='pi.tasks'] {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 12px 4px;
  padding: 5px 10px 6px;
  border-radius: 8px;
  border: 1px solid var(--l2);
  border-left: 2px solid var(--accent);
  background: var(--card);
  font-family: var(--tv-font, var(--mono));
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--t2);
  cursor: default;
}
[data-role='pi.tasks'] .sf-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-role='omp.editor'] > [data-role='pi.tasks'] { margin: 0 0 4px; }
[data-role='pi.tasks.head'] { color: var(--t3); font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; }
[data-role='pi.tasks.focus'] { color: var(--accent); font-weight: 600; cursor: pointer; }
[data-role='pi.tasks.question'] { display: none; }
[data-role='pi.tasks']:hover [data-role='pi.tasks.question'],
[data-role='pi.tasks']:focus-within [data-role='pi.tasks.question'] { display: flex; }
[data-role='pi.tasks.question'] { color: var(--warn); }
[data-role='pi.tasks.question'][data-tone='success'] { color: var(--ok); }
[data-role='pi.tasks.next'] { color: var(--t3); cursor: pointer; }
[data-role='pi.tasks.next']:hover, [data-role='pi.tasks.focus']:hover { text-decoration: underline; }
[data-role='pi.tasks.pop'] {
  display: none;
  position: absolute;
  left: -1px;
  right: -1px;
  bottom: 100%;
  z-index: 50;
  flex-direction: column;
  gap: 1px;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px 10px 8px;
  border-radius: 8px;
  border: 1px solid var(--l2);
  background: var(--card);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
[data-role='pi.tasks']:hover [data-role='pi.tasks.pop'] { display: flex; }
[data-role='pi.tasks.row'] { color: var(--t2); padding: 1px 4px; border-radius: 4px; cursor: pointer; }
[data-role='pi.tasks.row']:hover { background: var(--l1); color: var(--t1); }
[data-role='pi.tasks.row'][data-tone='accent'] { color: var(--accent); font-weight: 600; }
[data-role='pi.tasks.row'][data-tone='info'] { color: var(--a1); }
[data-role='pi.tasks.row'][data-tone='warning'] { color: var(--warn); }
[data-role='pi.tasks.row'][data-tone='success'] { color: var(--ok); }
[data-role='pi.tasks.row'][data-tone='muted'] { color: var(--t2); }
[data-role='pi.tasks.pq'] { color: var(--t3); font-size: 10px; }
.sf-overlay[data-role='pi.ask'] [data-role='pi.ask.question'] { gap: 8px; margin-bottom: 16px; }
.sf-overlay[data-role='pi.ask'] [data-role='pi.ask.option'] {
  border: 1px solid var(--l2);
  border-radius: var(--r-ctl);
  padding: 8px 12px;
  min-height: 28px;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.sf-overlay[data-role='pi.ask'] [data-role='pi.ask.option']:hover { background: var(--l1); }
.sf-overlay[data-role='pi.ask'] [data-role='pi.ask.option'][data-tone='accent'] { border-color: var(--sf-sel); background: var(--sf-mark-bg); }
.sf-overlay[data-role='pi.ask'] [data-role='pi.ask.actions'] { gap: 12px; align-items: center; }
.sf-overlay[data-role='pi.ask'] [data-role='pi.ask.action'] { padding: 6px 12px; border-radius: var(--r-ctl); background: var(--l1); cursor: pointer; }
[data-role='pi.board'] { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 4px; }
/* /btw card, inline in the composer slot: the newest exchange reads as body text, the input row is the boundary. */
[data-role='pi.btw.question'] { color: var(--t2); }
[data-role='pi.btw.answer'] { color: var(--t1); overflow-wrap: anywhere; }
[data-role='pi.btw.input'] { padding: 6px 0 2px; margin-top: 6px; border-top: 1px solid var(--l2); }
[data-role='pi.btw.hint'] { gap: 12px; align-items: center; margin-top: 2px; color: var(--t3); }
[data-role='pi.board.column'] { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 6px; border-radius: 8px; border: 1px solid var(--l2); background: color-mix(in srgb, var(--l1) 55%, transparent); }
[data-role='pi.board.head'] { color: var(--t2); font-size: 10px; font-weight: 600; letter-spacing: 0.02em; padding: 0 2px 4px; border-bottom: 1px solid var(--l2); }
[data-role='pi.board.card'] { padding: 5px 7px; border-radius: 6px; border: 1px solid var(--l2); background: var(--card); color: var(--t1); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-role='pi.board.card']:hover { border-color: var(--accent); }
[data-role='pi.board.card'][data-tone='accent'] { border-color: var(--accent); }
[data-role='pi.board.meta'] { color: var(--t3); font-size: 9.5px; padding-left: 2px; }
[data-role='pi.board.empty'] { color: var(--t3); font-size: 10px; text-align: center; padding: 8px 0; border: 1px dashed var(--l2); border-radius: 6px; }
[data-role='pi.tasks.head'][data-action='tasks.view'] { cursor: pointer; }
[data-role='tasks.call'] { font-family: var(--tv-font, var(--mono)); }
[data-role='tasks.body'] { gap: 3px; padding: 4px 2px; }
[data-role='tasks.state'] { color: var(--t3); font-size: 10px; padding: 2px 4px 0; }
`;
