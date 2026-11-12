// Regression harness for the health-probe budget. Run from the repository root:
//   node tools/e2e/asr-under-load.mjs /tmp/asr16.wav /tmp/asr-long.wav
//
// It queues long transcriptions on spark (the server runs max_concurrent: 1),
// then runs dictation through the real RemoteAsrBackend twice: once with the old
// 800 ms probe budget and once with the current default. The old budget reports
// "every endpoint failed" for a healthy but busy server; the current one
// transcribes. The wait loop below only waits for a real /health stall, so the
// comparison happens inside the failure window rather than next to it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function decodeWav16(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768;
      }
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const shortFile = process.argv[2] ?? "/tmp/asr16.wav";
const longFile = process.argv[3] ?? "/tmp/asr-long.wav";
const pcm = decodeWav16(readFileSync(shortFile));
const long = readFileSync(longFile);

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const voiceRoot = fileURLToPath(new URL("../../extensions/voice/", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "pi-voice-load-"));

function queueLoad(url, count) {
  const pending = [];
  for (let index = 0; index < count; index += 1) {
    const form = new FormData();
    form.set("file", new Blob([long], { type: "audio/wav" }), "long.wav");
    pending.push(fetch(`${url}/transcribe`, { method: "POST", body: form }).then((r) => r.json()));
  }
  return Promise.all(pending);
}

try {
  execFileSync(process.execPath, [tsc, "--noEmit", "false", "--outDir", out], {
    cwd: voiceRoot,
    stdio: "inherit",
  });
  const { RemoteAsrBackend, remoteAsrConfig } = await import(
    pathToFileURL(join(out, "src/remote-asr.js")).href
  );
  const config = remoteAsrConfig();
  if (!config) throw new Error("remote ASR is disabled by PI_VOICE_ASR");
  const tailscale = config.endpoints.find((endpoint) => endpoint.name === "tailscale");

  async function take(label, overrides) {
    try {
      const backend = new RemoteAsrBackend({ ...config, ...overrides });
      const started = Date.now();
      const text = await backend.transcribe(pcm);
      console.log(JSON.stringify({
        label,
        probeTimeoutMs: backend["config"].probeTimeoutMs,
        ok: true,
        totalMs: Date.now() - started,
        endpoint: backend.lastEndpoint?.name ?? null,
        probeMs: Math.round(backend.lastProbeMs),
        text,
      }));
    } catch (error) {
      console.log(JSON.stringify({ label, ok: false, error: error.message }));
    }
  }

  // Occupy the single GPU slot, then wait for an actual stall: the failure is a
  // race, so comparing budgets while /health is fast would prove nothing.
  const load = queueLoad(tailscale.url, 10);
  let peak = 0;
  const deadline = Date.now() + 20_000;
  while (peak < 1_000 && Date.now() < deadline) {
    const started = Date.now();
    try {
      const response = await fetch(`${tailscale.url}/health`, {
        signal: AbortSignal.timeout(6_000),
      });
      await response.text();
      peak = Math.max(peak, Date.now() - started);
    } catch {
      // A slow probe is itself the signal; the loop simply retries.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(JSON.stringify({ label: "observed /health stall", peakMs: peak }));

  await take("old 800 ms budget", { probeTimeoutMs: 800 });
  await take("current default budget", {});
  await take("second take (failed endpoint cooling down)", {});
  await load;
} finally {
  rmSync(out, { recursive: true, force: true });
}
