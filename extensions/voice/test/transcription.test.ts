import assert from "node:assert/strict";
import test from "node:test";
import type { BackendInfo, ModelOptions, TranscribeModel } from "transcribe-cpp";
import { TranscribeCppBackend } from "../src/transcription.js";

type RuntimeLoader = NonNullable<ConstructorParameters<typeof TranscribeCppBackend>[1]>;
type TestRuntime = Awaited<ReturnType<RuntimeLoader>>;

class TestOutOfMemory extends Error {}

const accelerator: BackendInfo = {
  name: "Vulkan0",
  description: "Test GPU",
  kind: "vulkan",
  deviceType: "gpu",
  deviceId: "0000:01:00.0",
  memoryTotal: 12_000_000_000,
  memoryFree: 1_000_000_000,
  index: 0,
};

const cpu: BackendInfo = {
  name: "CPU",
  description: "Test CPU",
  kind: "cpu",
  deviceType: "cpu",
  deviceId: null,
  memoryTotal: 16_000_000_000,
  memoryFree: 8_000_000_000,
  index: 1,
};

function fakeModel(dispose: () => void = () => {}): TranscribeModel {
  return { dispose } as unknown as TranscribeModel;
}

function runtime(options: {
  load: (path: string, modelOptions?: ModelOptions) => Promise<TranscribeModel>;
  devices?: BackendInfo[];
}): TestRuntime {
  return {
    TranscribeModel: { load: options.load },
    OutOfMemory: TestOutOfMemory,
    getAvailableBackends: () => options.devices ?? [accelerator, cpu],
    setLogHandler: () => {},
  } as unknown as TestRuntime;
}

test("an accelerator out-of-memory load retries on the exact CPU device", async () => {
  const calls: Array<{ path: string; options?: ModelOptions }> = [];
  const model = fakeModel();
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    async load(path, options) {
      calls.push({ path, options });
      if (!options) throw new TestOutOfMemory("GPU allocation failed");
      return model;
    },
  }));

  await backend.prepare();

  assert.deepEqual(calls, [
    { path: "model.gguf", options: undefined },
    { path: "model.gguf", options: { device: cpu } },
  ]);
  await backend.dispose();
});

test("a non-memory model-load failure is not retried", async () => {
  const failure = new Error("invalid model");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});

test("an out-of-memory failure is preserved when no CPU device is available", async () => {
  const failure = new TestOutOfMemory("GPU allocation failed");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    devices: [accelerator],
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});

test("a CPU-only out-of-memory failure is not retried", async () => {
  const failure = new TestOutOfMemory("CPU allocation failed");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    devices: [cpu],
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});
