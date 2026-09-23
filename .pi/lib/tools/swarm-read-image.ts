import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";

const mime: Record<string, string> = {
  ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};
export type PiContent = { type: "image"; data: string; mimeType: string } | { type: "text"; text: string };

/**
 * FSRead.Execute (forge/tools.go). Read is intentionally unrestricted: an
 * explicit path is resolved and passed to the filesystem without a workspace
 * or home-directory boundary. The caller validates `file_path` first
 * (FSRead.Validate → "file_path is required").
 */
export function readImage(filePath: string, workspacePath = process.cwd(), _approved = false): PiContent[] {
  if (typeof filePath !== "string" || filePath === "") throw new Error("cannot resolve path: empty path");
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(workspacePath, filePath);
  const ext = extname(abs).toLowerCase();
  if (!mime[ext]) return [{ type: "text", text: `ERROR: Read handles image files only (.gif, .jpeg, .jpg, .png, .webp). For text use the shell, e.g. \`sed -n '1,200p' ${abs}\` to view a slice or \`rg PATTERN ${abs}\` to search it.` }];
  let data: Buffer;
  try { data = readFileSync(abs); }
  catch (e: any) { return [{ type: "text", text: `ERROR: Failed to read image: failed to open image file: open ${abs}: ${e?.code === "ENOENT" ? "no such file or directory" : e?.message ?? String(e)}` }]; }
  if (data.length > 5_242_880) return [{ type: "text", text: `ERROR: Failed to read image: image file size exceeds limit: ${data.length} bytes (max: 5242880 bytes)` }];
  let size: number;
  try { size = statSync(abs).size; }
  catch (e: any) { return [{ type: "text", text: `ERROR: Failed to stat image: ${e?.message ?? String(e)}` }]; }
  return [
    { type: "image", data: data.toString("base64"), mimeType: mime[ext] },
    { type: "text", text: `Image file: ${basename(abs)} (${mime[ext]}, ${(size / 1024).toFixed(2)} KB)` },
  ];
}
