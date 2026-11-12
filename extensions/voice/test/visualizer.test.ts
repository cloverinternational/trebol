import assert from "node:assert/strict";
import { test } from "node:test";
import { SpectrumAnalyzer, WAVE_COLUMNS, waveformLevel } from "../src/visualizer.js";

test("analyzer levels rise on a tone and decay on silence", () => {
  const analyzer = new SpectrumAnalyzer();
  const tone = new Float32Array(512);
  for (let index = 0; index < tone.length; index += 1) {
    // 1 kHz at the 16 kHz capture rate.
    tone[index] = Math.sin((2 * Math.PI * index) / 16) * 0.5;
  }
  analyzer.push(tone);
  const peak = Math.max(...analyzer.bands);
  assert.ok(peak > 0);
  analyzer.push(new Float32Array(512));
  assert.ok(Math.max(...analyzer.bands) < peak);
  analyzer.reset();
  assert.ok(analyzer.bands.every((band) => band === 0));
});

test("waveform history scrolls one column per chunk and resets to silence", () => {
  const analyzer = new SpectrumAnalyzer();
  const tone = new Float32Array(512);
  for (let index = 0; index < tone.length; index += 1) {
    tone[index] = Math.sin((2 * Math.PI * index) / 16) * 0.5;
  }
  for (let index = 0; index < WAVE_COLUMNS + 8; index += 1) analyzer.push(tone);
  assert.equal(analyzer.levels.length, WAVE_COLUMNS);
  assert.ok(analyzer.levels.every((level) => level > 0 && level <= 1));

  analyzer.push(new Float32Array(512));
  assert.equal(analyzer.levels.at(-1), 0);
  assert.ok((analyzer.levels[0] ?? 0) > 0, "older columns keep scrollback");

  analyzer.reset();
  assert.ok(analyzer.levels.every((level) => level === 0));
});

test("waveform levels use a fixed dB window instead of a saturating gain", () => {
  assert.equal(waveformLevel(0), 0);
  // Room noise below the floor draws nothing, so a silent strip never normalises into a fake wave.
  assert.equal(waveformLevel(10 ** (-54 / 20)), 0);
  // Quiet and loud speech land at different heights; the old sqrt(rms * 14) pinned most of this to 1.
  assert.ok(Math.abs(waveformLevel(10 ** (-40 / 20)) - 8 / 36) < 1e-9);
  assert.ok(Math.abs(waveformLevel(0.1) - 28 / 36) < 1e-9);
  assert.equal(waveformLevel(0.5), 1);
});
