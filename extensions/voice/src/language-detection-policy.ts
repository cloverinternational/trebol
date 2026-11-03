import type { LangIdResult } from "transcribe-cpp";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { LANGUAGE_DETECTION_MODEL, displayLanguage, getCatalogModel, languageIdentity, resolveModelLanguage } from "./catalog.js";
import { describeError, log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";

type LanguageModel = {
  readonly languages: readonly string[];
  readonly capabilities: { readonly languageDetection: boolean };
};

export type DetectPolicy = { kind: "detect"; languages: string[]; allowed: string[] };
/** What a take does about language. Auto is never `fixed`; `unsupported` hides it. */
export type AutoLanguagePolicy =
  | { kind: "native" }
  | { kind: "fixed"; language: string }
  | DetectPolicy
  | { kind: "unsupported" };

const detectorCodes = new Map<string, string>(
  LANGUAGE_DETECTION_MODEL.languages.map((code) => [languageIdentity(code), code]),
);

/** Return the detector's own label (iw/jw/tl/no included). */
export function detectorLanguageCode(language: string): string | undefined {
  return detectorCodes.get(languageIdentity(language));
}

/** Whether this ASR model needs the external detector for Auto, independent of preferences. */
export function requiresLanguageDetector(model: LanguageModel): boolean {
  return !model.capabilities.languageDetection &&
    new Set(model.languages.map(languageIdentity)).size > 1;
}

/** Preferred languages this model supports, in preference order, one per identity. */
function compatiblePreferences(model: LanguageModel, preferred: readonly string[]): string[] {
  const byIdentity = new Map<string, string>();
  for (const preference of preferred) {
    const language = resolveModelLanguage(model, preference);
    if (language !== undefined && !byIdentity.has(languageIdentity(language))) {
      byIdentity.set(languageIdentity(language), language);
    }
  }
  return [...byIdentity.values()];
}

/** Supported preferred languages the external detector cannot identify (e.g. Irish). */
export function undetectablePreferences(model: LanguageModel, preferred: readonly string[]): string[] {
  if (!requiresLanguageDetector(model)) return [];
  return compatiblePreferences(model, preferred).filter((language) => detectorLanguageCode(language) === undefined);
}

/**
 * Resolve Auto. Without native detection, Auto exists only when at least two
 * preferred languages are supported and every one of them is detectable.
 */
export function autoLanguagePolicy(
  model: LanguageModel,
  preferred: readonly string[],
): AutoLanguagePolicy {
  // Native detection retains its existing unrestricted semantics.
  if (model.capabilities.languageDetection) return { kind: "native" };

  const languages = compatiblePreferences(model, preferred);
  const allowed = languages.map(detectorLanguageCode);
  if (languages.length < 2 || allowed.includes(undefined)) return { kind: "unsupported" };
  return { kind: "detect", languages, allowed: allowed as string[] };
}

/** The policy a take runs with: an explicit language is fixed. */
export function settingsLanguagePolicy(settings: TranscribeSettings): AutoLanguagePolicy {
  if (settings.transcriptionLanguage !== "auto") {
    return { kind: "fixed", language: settings.transcriptionLanguage };
  }
  const model = getCatalogModel(settings.model.id);
  // Test/injected backends may use noncatalog ids. Persisted settings never do.
  return model ? autoLanguagePolicy(model, settings.preferredLanguages) : { kind: "native" };
}

const WINDOW_SAMPLES = 7 * CAPTURE_SAMPLE_RATE;
const MIN_SAMPLES = CAPTURE_SAMPLE_RATE / 2;
// Log a pick as uncertain when it is less than 1.5x as likely as the
// runner-up (with two languages: p < 0.6). The pick is used either way.
const UNSURE_RATIO = 1.5;

/** Shown once per session when Auto runs without the detector on disk. */
export function missingDetectorWarning(fallback: string): string {
  return `The language detector isn't downloaded. Transcribed as ${displayLanguage(fallback)}. ` +
    "To download it, open /voice-settings and choose Auto detect as the transcription language.";
}

/**
 * Pick one language for a whole clip from its first seven seconds: always the
 * top candidate. Skipped (< 500 ms), failed, or malformed detection falls back
 * to the first preferred language; only the last two warn.
 */
export async function detectLanguage(
  policy: DetectPolicy,
  pcm: Float32Array,
  identify: (pcm: Float32Array, allowed: readonly string[]) => Promise<LangIdResult>,
): Promise<{ language: string; warning?: string }> {
  const fallback = policy.languages[0]!;
  const seconds = (pcm.length / CAPTURE_SAMPLE_RATE).toFixed(2);
  if (pcm.length < MIN_SAMPLES) {
    log.info(`language detection: skipped, the ${seconds} s clip is under the ` +
      `${MIN_SAMPLES / CAPTURE_SAMPLE_RATE} s minimum; transcribing as ${fallback}, the first preferred language`);
    return { language: fallback };
  }
  const transcribedAs = `Transcribed as ${displayLanguage(fallback)}.`;
  try {
    const result = await identify(pcm.subarray(0, WINDOW_SAMPLES), policy.allowed);
    const [first, second] = result.candidates;
    const language = policy.languages[policy.allowed.indexOf(result.code ?? "")];
    const scores = result.candidates.map((c) => `${c.code} ${(c.p * 100).toFixed(1)}%`).join(", ");
    const unsure = first && second && first.p < UNSURE_RATIO * second.p ? ", uncertain" : "";
    log.info(`language detection: ${language ?? "none"} (${scores}; ` +
      `${seconds} s, allowed mass ${(result.allowedMass * 100).toFixed(1)}%${unsure})`);
    if (!language || !first || !Number.isFinite(first.p)) {
      return { language: fallback, warning: `Couldn't detect the language. ${transcribedAs}` };
    }
    return { language };
  } catch (error) {
    log.warn(`Language detection failed: ${describeError(error)}`);
    return { language: fallback, warning: `Language detection failed (${describeError(error)}). ${transcribedAs}` };
  }
}
