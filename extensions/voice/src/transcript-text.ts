import { convertChineseOutput, shouldConvertChinese } from "./chinese.js";
import type { ChineseOutput } from "./settings.js";

export type TranscriptOptions = {
  language?: string;
  chineseOutput?: ChineseOutput;
  /** Chinese is a preferred or chosen language: convert any Chinese text. */
  chineseEnabled?: boolean;
};

/**
 * Shared final step for local and remote transcription: trim, then apply the
 * Chinese script preference. Keeping it here avoids the remote client pulling
 * transcribe.cpp into the runtime's eager import graph.
 */
export async function finishTranscript(
  text: string,
  detectedLanguage: string,
  options: TranscriptOptions,
): Promise<string> {
  const trimmed = text.trim();
  const language = detectedLanguage || options.language || "";
  return shouldConvertChinese(trimmed, {
    chineseEnabled: options.chineseEnabled ?? false,
    language,
  })
    ? convertChineseOutput(trimmed, options.chineseOutput ?? "simplified")
    : trimmed;
}
