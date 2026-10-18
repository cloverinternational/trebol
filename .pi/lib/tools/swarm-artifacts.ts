import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Tern draws raster blobs up to 16 MiB decoded (docs elements/data.md, protocol/transport.md#blobs). */
export const RASTER_MAX_BYTES = 16 * 1024 * 1024;
/** Tern draws SVG blobs up to 256 KiB and sanitizes them itself (elements/data.md#image). */
export const SVG_MAX_BYTES = 256 * 1024;
/** Upper bound for the PDF page-1 conversion input; larger files are reported, not converted. */
export const PDF_MAX_BYTES = 32 * 1024 * 1024;
/** Bounded SVG source returned to the model; the full file is still drawn by Tern. */
export const SVG_SOURCE_MAX_CHARS = 32 * 1024;
const CONVERT_TIMEOUT_MS = 15_000;
const HEAD_BYTES = 4096;

export type ArtifactKind = "png" | "jpeg" | "gif" | "webp" | "svg" | "pdf" | "other";

const MIME: Record<ArtifactKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  other: "application/octet-stream",
};

export const mimeOf = (kind: ArtifactKind): string => MIME[kind];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Classifies by leading bytes, so identical content gets the same kind whatever its extension. */
export function classifyArtifact(head: Buffer): ArtifactKind {
  if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  const ascii = head.subarray(0, 6).toString("latin1");
  if (ascii === "GIF87a" || ascii === "GIF89a") return "gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const text = head.toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("<") && /<svg[\s>]/i.test(text.slice(0, HEAD_BYTES))) return "svg";
  return "other";
}

export async function readHead(absPath: string): Promise<Buffer> {
  const handle = await open(absPath, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Workspace-relative POSIX path when inside the workspace, otherwise absolute. Same bytes give the same string on every OS. */
export function citationPath(workspace: string, absPath: string): string {
  const rel = relative(workspace, absPath);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return (inside ? rel : absPath).split(sep).join("/");
}

export function citationFor(workspace: string, absPath: string, page?: number): string {
  const path = citationPath(workspace, absPath);
  return page === undefined ? path : `${path}#page=${page}`;
}

/** Renders page 1 of a PDF to PNG with macOS sips. Other platforms have no converter in this repo. */
export async function pdfFirstPagePng(absPath: string, signal?: AbortSignal): Promise<Buffer> {
  if (process.platform !== "darwin") throw new Error("PDF preview needs macOS sips; this platform has no converter");
  const dir = await mkdtemp(join(tmpdir(), "swarm-pdf-"));
  try {
    const out = join(dir, "page-1.png");
    try {
      await run("sips", ["-s", "format", "png", absPath, "--out", out], { timeout: CONVERT_TIMEOUT_MS, signal, maxBuffer: 1 << 20 });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").split("\n")[0]?.trim();
      throw new Error(`PDF page 1 could not be rendered${stderr ? `: ${stderr.slice(0, 160)}` : ""}`);
    }
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Paths an apply_patch input creates or rewrites, in patch order. Deletions have nothing to preview. */
export function patchArtifactPaths(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const paths = new Set<string>();
  for (const line of input.split("\n")) {
    const match = /^\*\*\* (?:Update File|Add File|Move to): (.+?)\s*$/.exec(line);
    if (match?.[1]) paths.add(match[1]);
  }
  return [...paths];
}

export const isSupportedArtifact = (kind: ArtifactKind): boolean => kind !== "other";

/** Shared by Read and the Tern preview: the byte budget for a kind. */
export function sizeLimitFor(kind: ArtifactKind): number | undefined {
  if (kind === "svg") return SVG_MAX_BYTES;
  if (kind === "pdf") return PDF_MAX_BYTES;
  if (kind === "other") return undefined;
  return RASTER_MAX_BYTES;
}
