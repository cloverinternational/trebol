/** Presentation helpers for the image-only Read tool; dependency-free for headless use. */

/**
 * Minimal render-option surface the host passes to renderResult. The real
 * host contract is dynamic (see packages/runtime tool renderer); these are
 * the fields this renderer reads.
 */
export interface ReadRenderOptions {
  expanded?: boolean;
  isError?: boolean;
}

/** Minimal theme surface consumed here; host themes are richer and dynamic. */
export interface ReadTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

/** Read call arguments; the tool accepts several path aliases. */
export interface ReadCallArgs {
  file_path?: string;
  file?: string;
  path?: string;
  filename?: string;
  offset?: number;
  limit?: number;
}

interface ReadContentPart {
  type?: string;
  text?: string;
  mimeType?: string;
}

/** Minimal tool-result shape rendered here; extra fields are ignored. */
export interface ReadToolResult {
  content?: ReadContentPart[];
  details?: unknown;
  isError?: boolean;
}

/** Source lines shown inline under a Read caption before the rest is summarized. */
const SOURCE_PREVIEW_LINES = 12;

function textComponent(value: string) {
  return {
    render(width: number): string[] {
      if (width <= 0) return [""];
      return value.split("\n").flatMap((line) => {
        // Code-point-aware chunking: slicing by UTF-16 code units can split
        // surrogate pairs (emoji, non-BMP characters in paths/messages).
        const chars = Array.from(line);
        if (chars.length <= width) return [line];
        const rows: string[] = [];
        for (let i = 0; i < chars.length; i += width) rows.push(chars.slice(i, i + width).join(""));
        return rows;
      });
    },
    invalidate() {},
  };
}

const pathKeys = ["file_path", "file", "path", "filename"] as const;

const pathFrom = (args: ReadCallArgs | undefined): string | undefined => {
  for (const key of pathKeys) {
    const value = args?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

/** Keep range metadata tolerant: Read is image-only, but callers may supply it. */
export function formatReadCall(args: ReadCallArgs | undefined, theme: ReadTheme | undefined): string {
  const path = pathFrom(args) ?? "(path not provided)";
  const start = Number.isInteger(args?.offset) && args.offset! > 0 ? args!.offset : undefined;
  const limit = Number.isInteger(args?.limit) && args.limit! > 0 ? args!.limit : undefined;
  let range = "";
  if (start !== undefined) {
    const end = limit === undefined ? "+" : `-${start + limit - 1}`;
    range = ` · lines ${start}${end}`;
  }
  const title = theme?.fg?.("toolTitle", theme?.bold?.("Read") ?? "Read") ?? "Read";
  const pathText = theme?.fg?.("accent", path) ?? path;
  const suffix = theme?.fg?.("muted", range) ?? range;
  return `${title} ${pathText}${suffix}`;
}

function resultText(result: ReadToolResult | undefined, options: ReadRenderOptions | undefined, theme: ReadTheme | undefined): string {
  const parts = Array.isArray(result?.content) ? result!.content! : [];
  const textParts = parts.filter((p) => p?.type === "text" && typeof p.text === "string");
  const images = parts.filter((p) => p?.type === "image");
  const message = textParts.map((p) => p.text as string).join("\n").trim();
  const failed = Boolean(result?.isError || options?.isError || /^ERROR:/m.test(message));
  // Only the headline is the caption; a `Cite as:` line and an SVG source body may follow it.
  const [headline = "", ...detail] = message.split("\n");
  const caption = /^(?:Image|Document) file: (.+?) \(([^,]+), ([^)]+)\)(.*)$/.exec(headline);
  const rows: string[] = [];
  const title = failed ? "✗ Read failed" : "✓ Read image";
  rows.push(theme?.fg?.(failed ? "error" : "success", title) ?? title);
  if (images.length) {
    for (const image of images) {
      const mime = typeof image.mimeType === "string" ? image.mimeType : "unknown image type";
      rows.push(theme?.fg?.("muted", `▧ ${mime} image attached`) ?? `▧ ${mime} image attached`);
    }
  }
  if (caption && !failed) {
    rows.push(theme?.fg?.("accent", caption[1]!) ?? caption[1]!);
    const meta = `${caption[2]} · ${caption[3]}${caption[4] ?? ""}`;
    rows.push(theme?.fg?.("muted", meta) ?? meta);
    for (const line of detail) {
      if (!line.startsWith("Cite as: ")) continue;
      const cite = `⌁ ${line.slice("Cite as: ".length)}`;
      rows.push(theme?.fg?.("accent", cite) ?? cite);
    }
    const body = detail.filter((line) => !line.startsWith("Cite as: ")).join("\n").trim().split("\n").filter(Boolean);
    for (const line of body.slice(0, SOURCE_PREVIEW_LINES)) rows.push(theme?.fg?.("toolOutput", line) ?? line);
    if (body.length > SOURCE_PREVIEW_LINES) {
      const more = `… ${body.length - SOURCE_PREVIEW_LINES} more lines`;
      rows.push(theme?.fg?.("muted", more) ?? more);
    }
  } else if (message) rows.push(theme?.fg?.(failed ? "error" : "toolOutput", message) ?? message);
  else if (!images.length && !failed) rows.push(theme?.fg?.("muted", "No image content returned") ?? "No image content returned");
  // Read's successful payload is an image, not line-oriented text. Do not
  // truncate it or pretend offset/limit selects image lines; preserve messages.
  // The success/error state and the structured caption derive from the tool's
  // fixed message format ("ERROR:" prefix, "Image file: <path> (<mime>, <size>)").
  // Those strings are part of the tool↔renderer contract in this repository;
  // if the tool wording changes, this parser changes with it.
  if (options?.expanded && result?.details !== undefined) {
    // details is arbitrary tool output; never let a circular structure or a
    // throwing toJSON crash the renderer.
    try {
      rows.push(JSON.stringify(result.details, null, 2));
    } catch {
      rows.push("(details could not be serialized)");
    }
  }
  return rows.join("\n");
}

export const readToolRenderer = {
  renderCall(args: ReadCallArgs | undefined, theme: ReadTheme | undefined) {
    return textComponent(formatReadCall(args, theme));
  },
  renderResult(result: ReadToolResult | undefined, options: ReadRenderOptions | undefined, theme: ReadTheme | undefined) {
    return textComponent(resultText(result, options, theme));
  },
};
