// End-to-end remote dictation check. Run from the repository root:
//   node --experimental-strip-types tools/e2e/asr-remote.mjs /tmp/asr16.wav
//
// The WAV must be 16 kHz mono 16-bit, the format the microphone produces. The
// script drives the same DictationController -> TranscriptionService ->
// RemoteAsrBackend path as a real take, then prints the transcript and route.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function decodeWav16(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      format = {
        code: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        rate: buffer.readUInt32LE(offset + 12),
        bits: buffer.readUInt16LE(offset + 22),
      };
    } else if (id === "data") {
      data = buffer.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error("WAV has no fmt/data chunk");
  if (format.code !== 1 || format.channels !== 1 || format.bits !== 16) {
    throw new Error("expected 16-bit mono PCM");
  }
  if (format.rate !== 16_000) {
    throw new Error(`expected 16000 Hz, got ${format.rate} Hz`);
  }
  const pcm = new Float32Array(data.length / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = data.readInt16LE(index * 2) / 32768;
  }
  return pcm;
}

const file = process.argv[2] ?? "/tmp/asr16.wav";
const pcm = decodeWav16(readFileSync(file));
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const voiceRoot = fileURLToPath(new URL("../../extensions/voice/", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "pi-voice-e2e-"));

try {
  execFileSync(process.execPath, [tsc, "--noEmit", "false", "--outDir", out], {
    cwd: voiceRoot,
    stdio: "inherit",
  });
  const { RemoteAsrBackend, remoteAsrConfig } = await import(
    pathToFileURL(join(out, "src/remote-asr.js")).href
  );
  const { TranscriptionService } = await import(
    pathToFileURL(join(out, "src/transcription-service.js")).href
  );
  const { DictationController } = await import(
    pathToFileURL(join(out, "src/dictation-controller.js")).href
  );

  const config = remoteAsrConfig();
  if (!config) throw new Error("remote ASR is disabled by PI_VOICE_ASR");

  const backend = new RemoteAsrBackend(config);
  const service = new TranscriptionService(() => backend);
  const settings = {
    version: 1,
    backend: { type: "transcribe-cpp" },
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en"],
    transcriptionLanguage: "auto",
    chineseOutput: "simplified",
    microphone: { type: "system-default" },
    voiceActivityDetection: true,
    longformChunking: true,
    model: { source: "catalog", id: "unused", path: "unused" },
  };

  const controller = new DictationController(service, {
    openCapture: async (_microphone, sinks) => {
      // One chunk is enough: this checks the remote path, not chunk timing.
      sinks.onAudio(pcm);
      return { stop: async () => ({ pcm }) };
    },
  });

  try {
    await controller.start(settings);
    const result = await controller.stop();
    if (!result) throw new Error("dictation produced no result");
    console.log(JSON.stringify({
      file,
      text: result.text,
      speechSeconds: Number(result.speechSeconds.toFixed(2)),
      transcribeSeconds: Number(result.transcribeSeconds.toFixed(2)),
      endpoint: backend.lastEndpoint ?? null,
      probeMs: Math.round(backend.lastProbeMs),
      requestMs: Math.round(backend.lastTranscribeMs),
    }, null, 2));
  } finally {
    await controller.dispose();
    await service.shutdown();
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
