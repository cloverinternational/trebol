// Synthetic runner-path benchmark. No clipboard, provider, terminal or private session access.
// node --experimental-strip-types tools/e2e/tern-paste-bench.mjs
import { performance } from 'node:perf_hooks';
import { StdinBuffer } from '@earendil-works/pi-tui';
import { PiTernBridge } from '../../.pi/lib/tern/bridge.ts';
import { keyEffect } from '../../.pi/lib/tern/keys.ts';
import { PasteInput } from '../../.pi/lib/tern/paste-input.ts';
import assert from 'node:assert/strict';
const fixtures = { small: 'hello world', large: 'x'.repeat(10000), multiline: 'first\nsecond\nthird', unicode: 'á漢🙂'.repeat(100) };
for (const [name, text] of Object.entries(fixtures)) {
  for (const bracketed of [false, true]) {
    const times = []; let result;
    for (let trial = 0; trial < 7; trial++) {
      let renders = 0, submits = 0;
      const bridge = new PiTernBridge({ subscribe: () => () => {}, prompt: async () => { submits++; }, abort: async () => {}, dispose() {} }, { write() {}, surfaceId: 'bench', credits: 100000, onRender: () => renders++ });
      bridge.start(); renders = 0;
      const input = new StdinBuffer();
      input.on('paste', s => bridge.pasteText(s));
      input.on('data', s => { const e = keyEffect(s); if (e?.kind === 'text') bridge.appendDraft(e.text); else if (e?.kind === 'submit') submits++; });
      const pasteInput = new PasteInput(s => input.process(s), s => bridge.pasteText(s));
      const wire = bracketed ? '\x1b[200~' + text + '\x1b[201~' : text;
      const start = performance.now();
      for (let i = 0; i < wire.length; i += 256) pasteInput.process(wire.slice(i, i + 256));
      times.push(performance.now() - start);
      result = { renders, submits, preserved: bridge.expandedDraft === text };
      input.destroy(); bridge.close();
    }
    times.sort((a,b) => a-b);
    console.log(JSON.stringify({ name, bracketed, chars: text.length, medianMs: +times[3].toFixed(3), ...result }));
  }
}

// Isolate accumulation cost from rendering; compare the installed dependency to the runner adapter.
const largeText = 'e\u0301\r\n\t漢🙂'.repeat(100000);
const largeWire = '\x1b[200~' + largeText + '\x1b[201~';
for (const kind of ['installed-pi', 'new-runner']) {
  let out = '', events = 0;
  const got = s => { out = s; events++; };
  const parser = kind === 'installed-pi' ? new StdinBuffer() : new PasteInput(() => {}, got);
  if (kind === 'installed-pi') parser.on('paste', got);
  const start = performance.now();
  for (let at = 0; at < largeWire.length; at += 256) parser.process(largeWire.slice(at, at + 256));
  const ms = performance.now() - start;
  assert.equal(out, largeText); assert.equal(events, 1);
  console.log(JSON.stringify({ kind, chars: largeText.length, chunk: 256, ms, events, exact: true }));
  parser.destroy?.();
}
