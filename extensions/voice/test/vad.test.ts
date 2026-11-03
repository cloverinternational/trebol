import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_CHUNK_SAMPLES as FRAME } from "../src/audio-constants.js";
import { SpeechGate, VoiceActivityFilter, type VadScorer } from "../src/vad.js";

/** A frame whose samples all equal `value`; the fake scorer reads it back as the probability. */
function frame(value: number, samples = FRAME): Float32Array {
  return new Float32Array(samples).fill(value);
}

function frames(...runs: Array<[value: number, count: number]>): Float32Array[] {
  return runs.flatMap(([value, count]) => Array.from({ length: count }, () => frame(value)));
}

function fakeScorer(options: { failAt?: number } = {}) {
  const state = { scored: 0, disposed: 0 };
  const scorer: VadScorer = {
    async score(input) {
      assert.equal(input.length, FRAME);
      if (state.scored++ === options.failAt) throw new Error("native failure");
      return input[0]!;
    },
    dispose() { state.disposed++; },
  };
  return { state, scorer };
}

function filterWith(openScorer: () => Promise<VadScorer>, dropSilence = true) {
  const streamed: Float32Array[] = [];
  const probs: Array<readonly number[] | undefined> = [];
  const filter = new VoiceActivityFilter({
    openScorer,
    onSpeech: (chunk, chunkProbs) => { streamed.push(chunk); probs.push(chunkProbs); },
    hangoverMs: 450,
    dropSilence,
  });
  return { filter, streamed, probs };
}

const total = (chunks: readonly Float32Array[]) => chunks.reduce((sum, chunk) => sum + chunk.length, 0);

test("the gate needs a confirmed onset, releases pre-roll, and holds a hangover tail", () => {
  const gate = new SpeechGate({ prefillFrames: 3, onsetFrames: 2, hangoverFrames: 2 });
  const [a, b, c, d, e, f, g, h, i] = frames([0.1, 1], [0.2, 1], [0.3, 1], [0.4, 1], [0.5, 1], [0.6, 1], [0.7, 1], [0.8, 1], [0.9, 1]);
  assert.deepEqual(gate.push(a!, false), []);
  assert.deepEqual(gate.push(b!, true), [], "one voiced frame is not an onset");
  assert.deepEqual(gate.push(c!, false), [], "a broken onset resets");
  assert.deepEqual(gate.push(d!, true), []);
  // Onset: up to prefill + 1 buffered frames come out together, oldest first.
  assert.deepEqual(gate.push(e!, true), [b, c, d, e]);
  assert.equal(gate.inSpeech, true);
  assert.deepEqual(gate.push(f!, false), [f], "hangover 1");
  assert.deepEqual(gate.push(g!, false), [g], "hangover 2");
  assert.deepEqual(gate.push(h!, false), [], "tail over");
  assert.equal(gate.inSpeech, false);
  assert.deepEqual(gate.push(i!, false), []);
});

test("a word cut off before its onset is confirmed is still kept at the end", () => {
  const gate = new SpeechGate({ prefillFrames: 3, onsetFrames: 2, hangoverFrames: 2 });
  const [a, b] = frames([0.1, 1], [0.9, 1]);
  gate.push(a!, false);
  assert.deepEqual(gate.push(b!, true), []);
  assert.deepEqual(gate.finish(), [a, b]);
  assert.deepEqual(new SpeechGate({ prefillFrames: 3, onsetFrames: 2, hangoverFrames: 2 }).finish(), []);
});

test("the filter drops silence and keeps speech with pre-roll and hangover, streaming as it goes", async () => {
  const { state, scorer } = fakeScorer();
  const { filter, streamed } = filterWith(async () => scorer);
  for (const chunk of frames([0, 20], [0.9, 3], [0, 20])) filter.push(chunk);
  const kept = await filter.finish();
  // 15 pre-roll + 2 onset frames, 1 more voiced frame, 15 hangover frames.
  assert.equal(kept.length, (16 + 1 + 15) * FRAME);
  assert.equal(total(streamed), kept.length, "the stream saw exactly the kept audio");
  assert.equal(kept.filter((sample) => sample === Math.fround(0.9)).length, 3 * FRAME);
  assert.equal(state.scored, 43);
  assert.equal(state.disposed, 1);
});

test("a recording with no speech keeps nothing", async () => {
  const { filter, streamed } = filterWith(async () => fakeScorer().scorer);
  for (const chunk of frames([0, 30])) filter.push(chunk);
  filter.push(frame(0, 100));
  assert.equal((await filter.finish()).length, 0);
  assert.equal(streamed.length, 0);
});

test("a detector that can't load keeps the whole recording", async () => {
  const { filter, streamed } = filterWith(async () => { throw new Error("model missing"); });
  const recording = frames([0, 5], [0.9, 2], [0, 5]);
  for (const chunk of recording) filter.push(chunk);
  filter.push(frame(0, 100));
  const kept = await filter.finish();
  assert.equal(kept.length, total(recording) + 100);
  assert.equal(total(streamed), kept.length);
});

test("a detector failing mid-recording keeps undecided audio and passes the rest through", async () => {
  const { state, scorer } = fakeScorer({ failAt: 25 });
  const { filter } = filterWith(async () => scorer);
  for (const chunk of frames([0, 30])) filter.push(chunk);
  const kept = await filter.finish();
  // Frames 0-24 were silence: 0-8 are gone, 9-24 are still the pre-roll and
  // are kept, along with the failing frame and the 4 after it.
  assert.equal(kept.length, (16 + 1 + 4) * FRAME);
  assert.equal(state.disposed, 1);
});

test("discarding stops scoring, frees the session once idle, and finishes empty", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const disposed: string[] = [];
  const { filter, streamed } = filterWith(async () => ({
    async score() { await gate; return 1; },
    dispose() { disposed.push("session"); },
  }));
  for (const chunk of frames([1, 10])) filter.push(chunk);
  await new Promise((resolve) => setImmediate(resolve));
  filter.discard();
  assert.deepEqual(disposed, [], "a score is still in flight");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(disposed, ["session"]);
  assert.equal((await filter.finish()).length, 0);
  assert.equal(streamed.length, 0);
});

test("kept audio carries each whole frame's probability; without dropping silence, all of it is kept", async () => {
  const recording = frames([0, 20], [0.9, 3], [0, 20]);
  for (const dropSilence of [true, false]) {
    const { scorer } = fakeScorer();
    const { filter, streamed, probs } = filterWith(async () => scorer, dropSilence);
    for (const chunk of recording) filter.push(chunk);
    filter.push(frame(0, 100));
    const kept = await filter.finish();
    const all = probs.flatMap((chunkProbs) => chunkProbs ?? []);
    assert.equal(all.length, Math.floor(total(streamed) / FRAME));
    assert.equal(all.filter((prob) => prob === Math.fround(0.9)).length, 3);
    if (!dropSilence) assert.equal(kept.length, total(recording) + 100);
  }
});

test("audio kept after the detector fails has no probabilities", async () => {
  const { scorer } = fakeScorer({ failAt: 5 });
  const { filter, probs } = filterWith(async () => scorer, false);
  for (const chunk of frames([0.9, 10])) filter.push(chunk);
  await filter.finish();
  assert.deepEqual(probs.slice(0, 5), Array(5).fill([Math.fround(0.9)]));
  assert.ok(probs.slice(5).every((chunkProbs) => chunkProbs === undefined));
});
