/**
 * Pi surface styles. The composer carries OMP's omp.editor / omp.composer.* roles
 * (composer-view.ts), so Tern's built-in omp-composer.css and omp-chat-reader.css
 * draw it; nothing here restyles it.
 *
 * Stick to the selector subset Tern supports (docs/reference/tern-site/styles/css.md):
 * no `:has()`, no `~` combinator, and no leading region element — a program sheet is
 * prefixed with `[data-scope]`, so `.sf-main > …` can never match and only buys a
 * `{"ev":"error","sheet":"composer"}` at startup.
 *
 * Text sizes follow the terminal font. Tern documents a 13px design zoomed by `font / 13`
 * (styles/variables.md §Surface grid metrics), but the Tern 0.9.5 Linux desktop view updates
 * `--sf-fs` to the terminal font without zooming, so a plain `px` size stays frozen there.
 * `calc(var(--sf-fs, 13px) * N / 13)` is exactly N px under the zoom (where `--sf-fs` reads
 * 13px) and follows the font where there is none — the form Tern's own picker sheet uses.
 * Tern's composer rules are plain px, so the composer text Pi shows is restated below with
 * the same design sizes. The `[data-scope]` prefix adds no specificity, so each restated rule
 * matches the specificity of Tern's chat-skin rule (via stable role ancestors) and wins by
 * coming later. Keep this a template literal without interpolation: `/reload` reads it from source.
 */
export const PI_COMPOSER_CSS = `
.sf-col[data-role^='omp.editor'] [data-role='omp.composer.line'] > .sf-editor {
  --sf-lh: calc(var(--sf-fs, 13px) * 22 / 13);
  font-size: calc(var(--sf-fs, 13px) * 14 / 13);
  line-height: calc(var(--sf-fs, 13px) * 22 / 13);
}
.sf-col[data-role^='omp.editor'] [data-role='omp.composer.line'] > .sf-editor.code { font-size: calc(var(--sf-fs, 13px) * 13 / 13); }
[data-role='omp.composer.bar'] .sf-caption { font-size: calc(var(--sf-fs, 13px) * 12.5 / 13); }
[data-role='omp.composer.bar'] .sf-row[data-role='omp.composer.model'],
[data-role='omp.composer.bar'] .sf-row[data-role='omp.composer.effort'] { font-size: calc(var(--sf-fs, 13px) * 12.5 / 13); }
[data-role='omp.composer.bar'] .sf-place,
[data-role='omp.composer.bar'] .sf-place-dir,
[data-role='omp.composer.bar'] .sf-place-sep,
[data-role='omp.composer.bar'] .sf-place-leaf { font-size: calc(var(--sf-fs, 13px) * 11.5 / 13); }
[data-role='omp.composer.bar'] .sf-status[data-role='omp.composer.extras'],
[data-role='omp.composer.bar'] .sf-status[data-role='omp.composer.extras'] .sf-seg-t,
[data-role='omp.composer.bar'] [data-role='omp.composer.usage'] { font-size: calc(var(--sf-fs, 13px) * 11.5 / 13); }
[data-role='omp.composer.bar'] .sf-status[data-role='omp.composer.extras'] .sf-seg[data-tone] .sf-seg-t { font-size: calc(var(--sf-fs, 13px) * 11 / 13); }
[data-role='omp.composer.context'] .sf-mt-lbl,
[data-role='omp.composer.context'] .sf-mt-total { font-size: calc(var(--sf-fs, 13px) * 10 / 13); line-height: calc(var(--sf-fs, 13px) * 11 / 13); }
[data-role='omp.composer.bar'] [data-role='omp.composer.send'] .kbd { font-size: calc(var(--sf-fs, 13px) * 13 / 13); }
[data-role='omp.composer.bar'] [data-role='omp.composer.stop'] { font-size: calc(var(--sf-fs, 13px) * 12 / 13); }
.sf-col[data-role='pi.assistant'] { gap: var(--sf-inner-gap); padding: 0 2px; }
.sf-col[data-role='pi.assistant']:last-child .sf-md .md { font-family: var(--sans); }
.sf-card[data-role='pi.user']:not(:first-child) { margin-top: 8px; }
.sf-card[data-role='pi.user'] .sf-md .md { font-family: var(--sans); }
[data-role='pi.ask'] [data-role='pi.ask.question'] { gap: 8px; margin-bottom: 16px; }
[data-role='pi.ask'] [data-role='pi.ask.option'] {
  border: 1px solid var(--l2);
  border-radius: var(--r-ctl);
  padding: 10px 12px;
  min-height: 40px;
  overflow-wrap: anywhere;
  cursor: pointer;
}
[data-role='pi.ask'] [data-role='pi.ask.option']:hover { background: var(--l1); }
[data-role='pi.ask'] [data-role='pi.ask.option'][data-tone='accent'] { border-color: var(--sf-sel); background: var(--sf-mark-bg); }
[data-role='pi.ask'] [data-role='pi.ask.tabs'],
[data-role='pi.ask'] [data-role='pi.ask.hint'] { gap: 10px; align-items: center; flex-wrap: wrap; }
[data-role='pi.ask'] [data-role='pi.ask.tab'] {
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
}
[data-role='pi.ask'] [data-role='pi.ask.tab']:hover { background: var(--l1); }
[data-role='pi.ask'] [data-role='pi.ask.actions'] { gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
[data-role='pi.ask'] [data-role='pi.ask.action'] {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 8px 12px;
  border: 1px solid var(--l2);
  border-radius: var(--r-ctl);
  background: var(--l1);
  cursor: pointer;
}
[data-role='pi.ask'] [data-role='pi.ask.action']:hover { border-color: var(--accent); }
[data-role='pi.ask'] [data-role='pi.ask.action'][data-tone='accent'] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
[data-role='pi.ask'] [data-role='pi.ask.action'][data-tone='muted'] { color: var(--t3); }
[data-role='pi.ask'] [data-role='pi.ask.progress'] { gap: 8px; align-items: baseline; flex-wrap: wrap; }
[data-role='pi.ask'] [data-role='pi.ask.freeform'] {
  padding: 8px 10px;
  border-left: 2px solid var(--accent);
  border-radius: 6px;
  background: var(--l1);
}
/* A phone-width composer gives Send a labelled, comfortably tappable target. */
[data-role='pi.composer.send'] {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: var(--r-ctl);
  color: var(--accent);
  font-weight: 600;
  cursor: pointer;
}
[data-role='pi.composer.send']:hover { background: var(--l1); }

/* The plus sits on the editor line like Tern's own affixes: quiet until hovered, never competing with Send. */
[data-role='pi.composer.drawing'] {
  align-self: center;
  color: var(--t3);
  padding: 2px;
  border-radius: 6px;
  cursor: pointer;
}
[data-role='pi.composer.drawing']:hover { color: var(--t1); background: var(--l1); }
/* /btw card, inline in the composer slot: the newest exchange reads as body text, the input row is the boundary. */
[data-role='pi.btw.question'] { color: var(--t2); }
[data-role='pi.btw.answer'] { color: var(--t1); overflow-wrap: anywhere; }
[data-role='pi.btw.input'] { padding: 6px 0 2px; margin-top: 6px; border-top: 1px solid var(--l2); }
[data-role='pi.btw.hint'] { gap: 12px; align-items: center; margin-top: 2px; color: var(--t3); }
/* Task block: the transcript carries the live task rows only. The row keeps Tern's own drawing (icon,
   verb, target, facts, status), one step down the type scale from a work step; the open questions are
   small lines under their task, not a tool head each. */
[data-role='pi.tasks.block'] { margin-top: 6px; }
[data-role='pi.tasks.block-head'] { color: var(--t3); font-size: calc(var(--sf-fs, 13px) * 9.5 / 13); letter-spacing: 0.02em; padding-bottom: 1px; }
[data-role='pi.tasks.block'] .sf-tool-title,
[data-role='pi.tasks.block'] .sf-tool-target,
[data-role='pi.tasks.block'] .sf-tool-meta { font-size: calc(var(--sf-fs, 13px) * 11 / 13); }
[data-role='pi.tasks.line-q'] { color: var(--warn); font-size: calc(var(--sf-fs, 13px) * 10 / 13); padding-left: 2px; }
[data-role='pi.tasks.line-q'][data-tone='success'] { color: var(--ok); }
[data-role='pi.tasks.lines-more'] { color: var(--t3); font-size: calc(var(--sf-fs, 13px) * 9.5 / 13); padding-top: 2px; }
[data-role='tasks.call'] { font-family: var(--tv-font, var(--mono)); }
[data-role='tasks.body'] { gap: 3px; padding: 4px 2px; }
[data-role='tasks.state'] { color: var(--t3); font-size: calc(var(--sf-fs, 13px) * 10 / 13); padding: 2px 4px 0; }
/* The composer's Background button: the bar's other facts are clickable too, so it takes the pointer. */
[data-role='omp.composer.background'] { cursor: pointer; }
/* Running background work, as one pulse in the bar. No card, no ring: a blue spinner Tern clocks itself,
   the count, and the newest job's name only while the pointer or the keyboard is on it. The sheet owns
   every bit of visibility, so nothing here needs a frame from Pi. */
[data-role='pi.composer.work'] { cursor: pointer; }
[data-role='pi.composer.work'] [data-role='pi.composer.work.count'] { font-size: calc(var(--sf-fs, 13px) * 10.5 / 13); }
/* Hidden, not faded: display:none makes the name vanish the moment the pointer leaves. A floating panel
   is not an option here — the status band clips its children, so the list lives in the work sheet. */
[data-role='pi.composer.work'] [data-role='pi.composer.work.now'] {
  display: none;
  /* Tern lays sibling text nodes flush (the row's gap is not applied to them), so the name spaces itself. */
  margin-left: 6px;
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: calc(var(--sf-fs, 13px) * 10.5 / 13);
  color: var(--t3);
}
[data-role='pi.composer.work']:hover [data-role='pi.composer.work.now'],
[data-role='pi.composer.work']:focus-within [data-role='pi.composer.work.now'] { display: inline; }
`;
