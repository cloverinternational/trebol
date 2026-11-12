/**
 * Remote speech-to-text on the Clover GPU workstation ("spark").
 *
 * Dictation still records locally at 16 kHz mono. Only the decoded PCM is sent
 * to spark, as a WAV, and the returned text is inserted into the composer. The
 * local transcribe.cpp model is not loaded in this mode.
 *
 * Endpoint order is LAN first, then Tailscale. A short TCP connect check keeps a
 * dead LAN address from burning the full request budget without confusing a
 * busy server for a dead one. If both endpoints fail, the caller gets one error
 * naming both attempts; there is no silent local fallback.
 */
import { connect } from "node:net";
import { finishTranscript } from "./transcript-text.js";
import type { TranscriptionOptions } from "./transcription.js";

export type RemoteAsrEndpointName = "lan" | "tailscale";

export type RemoteAsrEndpoint = {
  name: RemoteAsrEndpointName;
  url: string;
};

export type RemoteAsrConfig = {
  endpoints: RemoteAsrEndpoint[];
  /** Parakeet model id for the OpenAI-compatible route. */
  model: string;
  token?: string;
  probeTimeoutMs: number;
  requestTimeoutMs: number;
  /** How long a failed endpoint waits before it is preferred again; doubles per failure. */
  retryBackoffMs?: number;
  retryBackoffMaxMs?: number;
};

const DEFAULT_LAN = "http://172.31.1.198:8001";
const DEFAULT_TAILSCALE = "http://100.84.178.124:8001";
const DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v3";
/**
 * Budget for a plain TCP connect, not for an HTTP round trip. `/health` on a
 * GPU-busy server answered only after the GPU work was free: p95 1.5 s, over
 * 3 s under queueing (measured when spark admitted one request at a time). That
 * made a healthy, busy server look dead. A connect reached spark in 55 ms idle
 * and under 1.8 s while uploads saturated the link, so 5 s leaves headroom
 * while still refusing a black hole.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 300_000;

function mode(env: NodeJS.ProcessEnv): string {
  return (env.PI_VOICE_ASR ?? "remote").trim().toLowerCase();
}

/** Remote is the default; `PI_VOICE_ASR=local` keeps the old local backend. */
export function remoteAsrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = mode(env);
  return value !== "local" && value !== "off" && value !== "false";
}

function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function remoteAsrConfig(
  env: NodeJS.ProcessEnv = process.env,
): RemoteAsrConfig | undefined {
  if (!remoteAsrEnabled(env)) return undefined;

  const lan = trimUrl(env.PI_VOICE_ASR_LAN_URL ?? DEFAULT_LAN);
  const tailscale = trimUrl(env.PI_VOICE_ASR_TAILSCALE_URL ?? DEFAULT_TAILSCALE);
  const endpoints: RemoteAsrEndpoint[] = [];
  if (lan) endpoints.push({ name: "lan", url: lan });
  if (tailscale && tailscale !== lan) {
    endpoints.push({ name: "tailscale", url: tailscale });
  }
  if (endpoints.length === 0) return undefined;

  return {
    endpoints,
    model: env.PI_VOICE_ASR_MODEL?.trim() || DEFAULT_MODEL,
    token: env.PI_VOICE_ASR_TOKEN?.trim() || undefined,
    probeTimeoutMs: positiveInt(
      env.PI_VOICE_ASR_PROBE_TIMEOUT_MS,
      DEFAULT_PROBE_TIMEOUT_MS,
    ),
    requestTimeoutMs: positiveInt(env.PI_VOICE_ASR_REQUEST_TIMEOUT_MS, 120_000),
  };
}

/** One 16-bit mono WAV around already-decoded capture PCM. */
export function encodeWav16(
  pcm: Float32Array,
  sampleRate = 16_000,
): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(sample * 32_767), true);
  }
  return new Uint8Array(buffer);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Transcription cancelled");
}

function limit(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

type RemoteText = { text: string; language?: string };

/** Consecutive failures and when the last one happened. */
type HealthMemo = { failures: number; at: number };

/**
 * A TranscriptionService backend. `prepare` is deliberately free: the server is
 * already running, and recording must not wait for a network round trip.
 */
export class RemoteAsrBackend {
  readonly remote = true as const;
  lastEndpoint?: RemoteAsrEndpoint;
  lastProbeMs = 0;
  lastTranscribeMs = 0;

  private readonly health = new Map<RemoteAsrEndpointName, HealthMemo>();

  constructor(private readonly config: RemoteAsrConfig) {}

  async prepare(): Promise<void> {
    if (this.config.endpoints.length === 0) {
      throw new Error("No remote transcription endpoints are configured");
    }
  }

  async dispose(): Promise<void> {}

  async transcribe(
    pcm: Float32Array,
    options: TranscriptionOptions = {},
  ): Promise<string> {
    if (pcm.length === 0) throw new Error("No audio samples were provided");
    await this.prepare();

    const wav = encodeWav16(pcm);
    const failures: string[] = [];
    for (const endpoint of this.endpointOrder()) {
      const started = performance.now();
      try {
        await this.probe(endpoint, options.signal);
        const probeMs = performance.now() - started;
        const result = await this.post(endpoint, wav, options);
        this.health.set(endpoint.name, { failures: 0, at: Date.now() });
        this.lastEndpoint = endpoint;
        this.lastProbeMs = probeMs;
        this.lastTranscribeMs = performance.now() - started - probeMs;
        return finishTranscript(result.text, result.language ?? "", options);
      } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        const previous = this.health.get(endpoint.name);
        this.health.set(endpoint.name, {
          failures: (previous?.failures ?? 0) + 1,
          at: Date.now(),
        });
        failures.push(`${endpoint.name} (${endpoint.url}): ${describe(error)}`);
      }
    }

    throw new Error(
      `Remote transcription failed on every endpoint. ${failures.join("; ")}`,
    );
  }

  /**
   * Configured order, except endpoints that failed recently move to the back.
   * LAN stays first whenever it is untried or usable, so a real LAN path is used
   * immediately; a black-holed LAN address stops costing its probe budget on
   * every subsequent take. When every endpoint is cooling down they are all
   * still attempted, so a recovered server is never permanently given up on.
   */
  private endpointOrder(): RemoteAsrEndpoint[] {
    const backoff = this.config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const cap = this.config.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;
    const now = Date.now();
    const ready: RemoteAsrEndpoint[] = [];
    const cooling: RemoteAsrEndpoint[] = [];
    for (const endpoint of this.config.endpoints) {
      const memo = this.health.get(endpoint.name);
      const wait = memo?.failures
        ? Math.min(cap, backoff * 2 ** (memo.failures - 1))
        : 0;
      const waiting = memo !== undefined && memo.failures > 0 && now - memo.at < wait;
      (waiting ? cooling : ready).push(endpoint);
    }
    return [...ready, ...cooling];
  }

  private async probe(
    endpoint: RemoteAsrEndpoint,
    outer?: AbortSignal,
  ): Promise<void> {
    const url = new URL(endpoint.url);
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const signal = limit(this.config.probeTimeoutMs, outer);

    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => {
        finish(
          outer?.aborted
            ? abortReason(outer)
            : new Error(
                `connect timed out after ${this.config.probeTimeoutMs} ms`,
              ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => finish());
      socket.once("error", (error) => finish(new Error(`connection failed: ${error.message}`)));
      if (signal.aborted) onAbort();
    });
  }

  private async post(
    endpoint: RemoteAsrEndpoint,
    wav: Uint8Array,
    options: TranscriptionOptions,
  ): Promise<RemoteText> {
    const language = options.language && options.language !== "auto"
      ? options.language
      : undefined;
    const path = language ? "/v1/audio/transcriptions" : "/transcribe";
    const form = new FormData();
    form.set("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
    if (language) {
      form.set("model", this.config.model);
      form.set("language", language);
      form.set("response_format", "json");
    }

    const signal = limit(this.config.requestTimeoutMs, options.signal);
    let response: Response;
    try {
      response = await fetch(`${endpoint.url}${path}`, {
        method: "POST",
        body: form,
        signal,
        headers: this.config.token
          ? { authorization: `Bearer ${this.config.token}` }
          : undefined,
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      throw new Error(`request failed: ${describe(error)}`);
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`response was not JSON: ${raw.slice(0, 200)}`);
    }
    if (!isObject(parsed) || typeof parsed.text !== "string") {
      throw new Error(`response had no text: ${raw.slice(0, 200)}`);
    }
    return {
      text: parsed.text,
      language: typeof parsed.language === "string" ? parsed.language : undefined,
    };
  }
}
