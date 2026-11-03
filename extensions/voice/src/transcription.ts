import type {
  BackendInfo,
  Capabilities,
  LangIdResult,
  Session,
  Stream,
  TranscribeModel,
} from "transcribe-cpp";
import { convertChineseOutput, shouldConvertChinese } from "./chinese.js";
import { describeError, log, writeLog, type LogLevel } from "./log.js";
import type { ChineseOutput } from "./settings.js";

export type TranscriptionOptions = {
  signal?: AbortSignal;
  language?: string;
  chineseOutput?: ChineseOutput;
  /** Chinese is a preferred or chosen language: convert any Chinese text. */
  chineseEnabled?: boolean;
};

export type DictationStream = {
  /** `probs` are the chunk's Silero frame probabilities, when the take has them. */
  feed(chunk: Float32Array, probs?: readonly number[]): Promise<void>;
  /** `audio` is the whole take, for a stream that checks it saw all of it. */
  finalize(audio?: Float32Array): Promise<string>;
  reset(): void;
};

function validateLanguage(
  capabilities: Pick<Capabilities, "languages">,
  language: string | undefined,
): void {
  if (language && !capabilities.languages.includes(language)) {
    throw new Error(
      `Configured language ${language} is not supported by this model. Open /voice-settings and choose another language.`,
    );
  }
}

/**
 * Shared final step for batch and streaming output: trim, then apply the
 * Chinese script preference (see shouldConvertChinese). Keeping this in one
 * place keeps the two paths from drifting.
 */
async function finishTranscript(
  text: string,
  detectedLanguage: string,
  options: TranscriptionOptions,
): Promise<string> {
  const trimmed = text.trim();
  const language = detectedLanguage || options.language || "";
  return shouldConvertChinese(trimmed, { chineseEnabled: options.chineseEnabled ?? false, language })
    ? convertChineseOutput(trimmed, options.chineseOutput ?? "simplified")
    : trimmed;
}

class TranscribeCppDictationStream implements DictationStream {
  private closed = false;

  constructor(
    private readonly session: Session,
    private readonly stream: Stream,
    private readonly options: TranscriptionOptions,
  ) {}

  async feed(chunk: Float32Array): Promise<void> {
    if (this.closed) throw new Error("Dictation stream is closed");
    await this.stream.feed(chunk);
  }

  async finalize(): Promise<string> {
    if (this.closed) throw new Error("Dictation stream is closed");

    let text: string;
    let detectedLanguage: string;
    try {
      await this.stream.finalize();
      if (this.closed) {
        throw new Error("Dictation stream was reset while finalizing");
      }
      const snapshot = this.stream.snapshot;
      text = snapshot.text;
      detectedLanguage = snapshot.language;
    } finally {
      this.close();
    }

    return finishTranscript(text, detectedLanguage, this.options);
  }

  reset(): void {
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    // reset() is synchronous at the binding boundary and queues native teardown
    // behind any in-flight feed/finalize before the session is freed.
    this.stream.reset();
    this.session.dispose();
  }
}

// transcribe-cpp's levels (TRANSCRIBE_LOG_LEVEL_*). Its info is a screenful
// of GPU setup on every model load, so it goes to debug.
const TRANSCRIBE_LEVELS: Record<number, LogLevel> = { 1: "debug", 2: "warn", 3: "error", 4: "debug" };
const TRANSCRIBE_CONTINUATION = 5;
let lastTranscribeLevel: LogLevel = "debug";

export function routeTranscribeLog(setLogHandler: typeof import("transcribe-cpp").setLogHandler): void {
  setLogHandler((level, message) => {
    if (level !== TRANSCRIBE_CONTINUATION) lastTranscribeLevel = TRANSCRIBE_LEVELS[level] ?? "debug";
    writeLog(lastTranscribeLevel, "transcribe", message);
  });
}

type TranscribeCppRuntime = Pick<
  typeof import("transcribe-cpp"),
  "getAvailableBackends" | "OutOfMemory" | "setLogHandler" | "TranscribeModel"
>;

type RuntimeLoader = () => Promise<TranscribeCppRuntime>;

// Best-effort: load failures don't report their device, so any non-CPU device is assumed to have been used.
function cpuFallbackDevice(runtime: TranscribeCppRuntime): BackendInfo | undefined {
  const devices = runtime.getAvailableBackends();
  const acceleratorAvailable = devices.some((device) => device.deviceType !== "cpu");
  return acceleratorAvailable
    ? devices.find((device) => device.deviceType === "cpu")
    : undefined;
}

/**
 * A reusable loaded transcribe.cpp model: an ASR model, or the language
 * detector. Calls must be scheduled sequentially.
 */
export class TranscribeCppBackend {
  private model: TranscribeModel | undefined;
  private loading: Promise<TranscribeModel> | undefined;
  private disposed = false;

  constructor(
    private readonly modelPath: string,
    private readonly loadRuntime: RuntimeLoader = () => import("transcribe-cpp"),
  ) {}

  async prepare(): Promise<void> {
    if (this.model) return;
    if (this.disposed) throw new Error("Transcription backend has been disposed");

    if (!this.loading) {
      this.loading = this.loadRuntime()
        .then(async (runtime) => {
          routeTranscribeLog(runtime.setLogHandler);
          try {
            return await runtime.TranscribeModel.load(this.modelPath);
          } catch (error) {
            if (!(error instanceof runtime.OutOfMemory)) throw error;
            const cpu = cpuFallbackDevice(runtime);
            if (!cpu) throw error;
            log.warn(`accelerator model load ran out of memory; retrying on CPU: ${describeError(error)}`);
            return runtime.TranscribeModel.load(this.modelPath, { device: cpu });
          }
        })
        .then((model) => {
          if (this.disposed) {
            model.dispose();
            throw new Error("Transcription backend was disposed while loading");
          }
          this.model = model;
          return model;
        });
    }

    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  async startStream(
    options: TranscriptionOptions = {},
  ): Promise<DictationStream | undefined> {
    await this.prepare();
    const model = this.model!;
    const capabilities = model.capabilities;
    validateLanguage(capabilities, options.language);
    if (!capabilities.supportsStreaming) return undefined;

    const session = model.createSession();
    try {
      const stream = await session.stream({
        timestamps: "none",
        ...(options.language ? { language: options.language } : {}),
      });
      return new TranscribeCppDictationStream(
        session,
        stream,
        options,
      );
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  async transcribe(
    pcm: Float32Array,
    options: TranscriptionOptions = {},
  ): Promise<string> {
    if (pcm.length === 0) throw new Error("No audio samples were provided");
    await this.prepare();
    const model = this.model!;
    validateLanguage(model.capabilities, options.language);

    const result = await model.transcribe(pcm, {
      signal: options.signal,
      timestamps: "none",
      ...(options.language ? { language: options.language } : {}),
    });
    return finishTranscript(
      result.text,
      result.language,
      options,
    );
  }

  /** Rank `allowed` detector labels for one clip (a "langid" model only). */
  async identifyLanguage(
    pcm: Float32Array,
    allowed: readonly string[],
    signal?: AbortSignal,
  ): Promise<LangIdResult> {
    await this.prepare();
    const session = this.model!.createLangIdSession();
    try {
      return await session.run(pcm, { allowed, signal });
    } finally {
      session.dispose();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.loading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
  }
}
