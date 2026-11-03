import type { ChineseOutput } from "./settings.js";

type Converter = (text: string) => string;

const converters = new Map<ChineseOutput, Promise<Converter>>();

async function createConverter(output: ChineseOutput): Promise<Converter> {
  const { default: OpenCC } = await import("opencc-js");
  switch (output) {
    case "simplified":
      return OpenCC.Converter({ from: "t", to: "cn" });
    case "traditional-taiwan":
      return OpenCC.Converter({ from: "cn", to: "tw" });
    case "traditional-hong-kong":
      return OpenCC.Converter({ from: "cn", to: "hk" });
  }
}

function converterFor(output: ChineseOutput): Promise<Converter> {
  const existing = converters.get(output);
  if (existing) return existing;

  const loading = createConverter(output);
  converters.set(output, loading);
  void loading.catch(() => {
    if (converters.get(output) === loading) converters.delete(output);
  });
  return loading;
}

export function isChineseLanguage(language: string): boolean {
  const base = language.toLowerCase().split("-", 1)[0];
  return base === "zh" || base === "yue";
}

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Whether a transcript gets the Chinese script preference. The text decides,
 * not language detection: on short clips the detector often says English for
 * Mandarin, which used to leave the model's Simplified output unconverted.
 * Kana means Japanese, whose kanji OpenCC would mangle (学→學, 図書館→图书馆).
 */
export function shouldConvertChinese(
  text: string,
  { chineseEnabled, language }: { chineseEnabled: boolean; language: string },
): boolean {
  if (!HAN.test(text) || KANA.test(text)) return false;
  return chineseEnabled || isChineseLanguage(language);
}

export async function convertChineseOutput(
  text: string,
  output: ChineseOutput,
): Promise<string> {
  return (await converterFor(output))(text);
}

export function chineseOutputSummary(output: ChineseOutput): string {
  switch (output) {
    case "simplified":
      return "Simplified";
    case "traditional-taiwan":
      return "Traditional (Taiwan)";
    case "traditional-hong-kong":
      return "Traditional (Hong Kong)";
  }
}
