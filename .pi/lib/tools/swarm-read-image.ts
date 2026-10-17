import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { SVG_SOURCE_MAX_CHARS, citationFor, classifyArtifact, mimeOf, pdfFirstPagePng, readHead, sizeLimitFor } from "./swarm-artifacts.ts";

const READABLE = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp", ".svg", ".pdf"]);
export type PiContent = { type: "image"; data: string; mimeType: string } | { type: "text"; text: string };

const text = (value: string): PiContent[] => [{ type: "text", text: value }];
const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(2)} KB`;

/**
 * FSRead.Execute (forge/tools.go). Read is intentionally unrestricted: an
 * explicit path is resolved and passed to the filesystem without a workspace
 * or home-directory boundary. The caller validates `file_path` first
 * (FSRead.Validate → "file_path is required").
 *
 * Supported: raster images as pictures, SVG as bounded source text, and PDF
 * page 1 as a PNG picture. Every success ends with a `Cite as:` line.
 */
export async function readArtifact(filePath: string, workspacePath = process.cwd(), signal?: AbortSignal): Promise<PiContent[]> {
  if (typeof filePath !== "string" || filePath === "") throw new Error("cannot resolve path: empty path");
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(workspacePath, filePath);
  const name = basename(abs);
  if (!READABLE.has(extname(abs).toLowerCase())) {
    return text(`ERROR: Read handles images, SVG and PDF files only (.gif, .jpeg, .jpg, .png, .webp, .svg, .pdf). For other files use the shell, e.g. \`sed -n '1,200p' ${abs}\` to view a slice or \`rg PATTERN ${abs}\` to search it.`);
  }
  let size: number;
  let head: Buffer;
  try {
    size = (await stat(abs)).size;
    head = await readHead(abs);
  } catch (e: any) {
    return text(`ERROR: Failed to read image: failed to open image file: open ${abs}: ${e?.code === "ENOENT" ? "no such file or directory" : e?.message ?? String(e)}`);
  }
  const kind = classifyArtifact(head);
  if (kind === "other") return text(`ERROR: ${name} is not a PNG, JPEG, GIF, WebP, SVG or PDF file; its contents do not match its extension.`);
  const limit = sizeLimitFor(kind)!;
  if (size > limit) return text(`ERROR: Failed to read ${kind}: file size exceeds limit: ${size} bytes (max: ${limit} bytes)`);
  const cite = citationFor(workspacePath, abs, kind === "pdf" ? 1 : undefined);

  if (kind === "svg") {
    const source = await readFile(abs, "utf8");
    const shown = source.length > SVG_SOURCE_MAX_CHARS ? `${source.slice(0, SVG_SOURCE_MAX_CHARS)}\n… (source truncated at ${SVG_SOURCE_MAX_CHARS} characters)` : source;
    return text(`Image file: ${name} (${mimeOf(kind)}, ${kilobytes(size)})\nCite as: ${cite}\n\n${shown}`);
  }
  if (kind === "pdf") {
    try {
      const png = await pdfFirstPagePng(abs, signal);
      return [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        { type: "text", text: `Document file: ${name} (${mimeOf(kind)}, ${kilobytes(size)}), page 1 shown\nCite as: ${cite}` },
      ];
    } catch (e) {
      return text(`ERROR: Failed to render PDF page 1: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const data = await readFile(abs);
  return [
    { type: "image", data: data.toString("base64"), mimeType: mimeOf(kind) },
    { type: "text", text: `Image file: ${name} (${mimeOf(kind)}, ${kilobytes(size)})\nCite as: ${cite}` },
  ];
}
