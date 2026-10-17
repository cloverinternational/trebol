import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { citationFor, classifyArtifact, mimeOf, pdfFirstPagePng, readHead, sizeLimitFor, type ArtifactKind } from "../tools/swarm-artifacts.ts";
import type { TspNode } from "./tsp.ts";

/** A picture Tern can draw: `id` is the SHA-256 of `bytes`, which Tern re-checks on receipt. */
export interface ArtifactBlob {
  id: string;
  mime: string;
  base64: string;
}

export interface ArtifactPreview {
  name: string;
  path: string;
  citation: string;
  blob?: ArtifactBlob;
  reason?: string;
}

const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Previews one file. Returns null for files that are not artifacts (missing,
 * text, unreadable) so ordinary tool rows stay exactly as they were. Every
 * artifact that is recognised yields either a blob or an honest reason.
 */
export async function previewFile(absPath: string, workspace: string, signal?: AbortSignal): Promise<ArtifactPreview | null> {
  let size: number;
  let kind: ArtifactKind;
  try {
    size = (await stat(absPath)).size;
    kind = classifyArtifact(await readHead(absPath));
  } catch {
    return null;
  }
  if (kind === "other") return null;
  const name = basename(absPath);
  const base = { name, path: absPath, citation: citationFor(workspace, absPath, kind === "pdf" ? 1 : undefined) };
  const limit = sizeLimitFor(kind)!;
  if (size > limit) return { ...base, reason: `${kind.toUpperCase()} is ${kilobytes(size)}, over the ${kilobytes(limit)} preview limit` };
  try {
    const bytes = kind === "pdf" ? await pdfFirstPagePng(absPath, signal) : await readFile(absPath);
    const mime = kind === "pdf" ? "image/png" : mimeOf(kind);
    return { ...base, blob: { id: createHash("sha256").update(bytes).digest("hex"), mime, base64: bytes.toString("base64") } };
  } catch (error) {
    return { ...base, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Card per preview: a labelled header, the picture (or the reason it is
 * missing), and a muted citation line. Previews are additive display only;
 * the tool result itself is never changed.
 */
export function artifactNodes(itemId: string, previews: readonly ArtifactPreview[]): TspNode[] {
  return previews.map((preview, i) => {
    const id = `${itemId}-art-${i}`;
    const head = "Preview";
    const cite: TspNode = { id: `${id}-cite`, k: "text", p: { role: "pi.artifact.cite", text: `Cite: ${preview.citation}`, tone: "muted", wrap: "none" } };
    if (!preview.blob) {
      const reason: TspNode = { id: `${id}-reason`, k: "text", p: { role: "pi.artifact.reason", text: preview.reason ?? `${preview.name} could not be previewed`, tone: "muted" } };
      return { id, k: "card", p: { head, role: "pi.artifact", tone: "muted" }, c: [reason, cite] };
    }
    const picture: TspNode = {
      id: `${id}-img`,
      k: "image",
      p: { blob: preview.blob.id, alt: preview.name, title: preview.citation, path: preview.path, max: { h: "24lines" } },
    };
    return { id, k: "card", p: { head, role: "pi.artifact", tone: "accent" }, c: [picture, cite] };
  });
}

