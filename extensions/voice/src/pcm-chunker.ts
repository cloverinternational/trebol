import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";

const STREAM_CHUNK_SAMPLES = CAPTURE_SAMPLE_RATE / 2;

/**
 * Coalesces recorder chunks into fresh Float32 PCM chunks without timers,
 * along with their Silero frame probabilities: a chunk has them only when
 * every piece of it did.
 */
export class PcmChunker {
  private pieces: Float32Array[] = [];
  private probs: number[] | undefined = [];
  private sampleCount = 0;

  constructor(
    private readonly onChunk: (chunk: Float32Array, probs?: readonly number[]) => void,
    private readonly targetSamples = STREAM_CHUNK_SAMPLES,
  ) {
    if (!Number.isInteger(targetSamples) || targetSamples <= 0) {
      throw new Error("PCM chunk size must be a positive integer");
    }
  }

  push(samples: Float32Array, probs?: readonly number[]): void {
    if (samples.length === 0) return;
    this.pieces.push(samples);
    if (probs && this.probs) this.probs.push(...probs);
    else this.probs = undefined;
    this.sampleCount += samples.length;
    if (this.sampleCount >= this.targetSamples) this.emit();
  }

  flush(): void {
    if (this.sampleCount > 0) this.emit();
  }

  discard(): void {
    this.pieces = [];
    this.probs = [];
    this.sampleCount = 0;
  }

  private emit(): void {
    const pcm = new Float32Array(this.sampleCount);
    let offset = 0;
    for (const piece of this.pieces) {
      pcm.set(piece, offset);
      offset += piece.length;
    }
    const probs = this.probs;
    this.pieces = [];
    this.probs = [];
    this.sampleCount = 0;
    this.onChunk(pcm, probs);
  }
}
