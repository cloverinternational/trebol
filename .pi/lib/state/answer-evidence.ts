import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { redactKnowledge, type EvidenceRef } from "./knowledge-store.ts";
import { memoryIdentity } from "./shared-memory.ts";
import { splitEvidence } from "../../../packages/tools/taskmanage/src/task-manage.ts";

/** Evidence anchoring for TaskManage answers.
 *
 * "verified" here means only: every cited reference resolved at capture time
 * and its anchored content is unchanged now. It does NOT prove the answer is
 * correct. Rule (explicit, deterministic, no model):
 *   - span    (`path#Lx-Ly`)    anchored: quote = redacted span text; re-checked on read.
 *   - heading (`file.md#Text`)  anchored: quote = heading line; re-checked on read.
 *   - tool    (`tool:Name#n`)   anchored: resolved to `<session>#<entryId>` with a
 *     non-empty result excerpt. Session entries are append-only, so not re-read.
 *   - path    (bare path)       exists-only: re-checked, but cannot verify alone.
 *   verified  <=> >=1 anchored ref AND every ref resolved; otherwise candidate.
 */
export type AnchorKind = "span" | "heading" | "tool" | "path";
export interface ResolvedRef { kind: AnchorKind | "unresolved"; ref: EvidenceRef; reason?: string }

const MAX_QUOTE = 1000, MAX_SPAN_LINES = 200, MAX_BYTES = 2_000_000;
const SENSITIVE = /(^|\/)(\.git|\.swarm|\.swarmpi|node_modules)(\/|$)|(^|\/)\.env|secret|credential|\.(pem|key|p12)$/i;
export const ANSWER_SOURCE = "taskmanage-answer";
export const answerId = (session: string, taskId: string, questionId: string) =>
  createHash("sha256").update(`taskmanage-answer:v1\n${session}\n${taskId}\n${questionId}`).digest("hex").slice(0, 32);

/** Paths are resolved from `base` (the cwd TaskManage validated against at
 * capture; the worktree root on re-check) but bounded by and stored relative to
 * the git worktree root, the same identity that keys the worktree store. Recall
 * from any subdirectory therefore re-checks the same file. */
function workspaceFile(cwd: string, path: string, base = cwd): { abs: string; rel: string } | string {
  let workspace: string, abs: string;
  try { workspace = realpathSync(memoryIdentity(cwd).worktree); abs = realpathSync(isAbsolute(path) ? path : resolve(realpathSync(base), path)); } catch { return "missing"; }
  const rel = relative(workspace, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "outside_workspace";
  if (SENSITIVE.test(rel)) return "sensitive_path";
  try { const s = statSync(abs); if (!s.isFile()) return "not_a_file"; if (s.size > MAX_BYTES) return "too_large"; } catch { return "missing"; }
  return { abs, rel };
}
const lines = (abs: string) => readFileSync(abs, "utf8").split(/\r?\n/);
const spanQuote = (all: string[], start: number, end: number) => redactKnowledge(all.slice(start - 1, end).join("\n")).slice(0, MAX_QUOTE);
const headingLine = (all: string[], text: string) => all.find(line => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === text.trim().toLowerCase());
const textOf = (message: any) => typeof message?.content === "string" ? message.content : Array.isArray(message?.content)
  ? message.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n") : "";

/** Resolve one TaskManage evidence reference at completion time. */
export function resolveAnswerRef(cwd: string, raw: string, session: { file?: string; entries?: readonly any[] }): ResolvedRef {
  const ref = raw.trim().slice(0, 2000);
  const tool = /^tool:([A-Za-z0-9_-]+)(?:#(\d+))?$/i.exec(ref);
  if (tool) {
    const results = (session.entries ?? []).filter(e => e?.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === tool[1]);
    const entry = tool[2] ? results[Number(tool[2]) - 1] : results.at(-1);
    if (!entry || typeof entry.id !== "string" || !session.file) return { kind: "unresolved", ref: { ref }, reason: "tool_result_unavailable" };
    const quote = redactKnowledge(textOf(entry.message)).trim().slice(0, MAX_QUOTE);
    if (!quote) return { kind: "unresolved", ref: { ref }, reason: "empty_tool_result" };
    return { kind: "tool", ref: { ref: `${session.file}#${entry.id}`, quote } };
  }
  const span = /^(.+?)#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(ref);
  if (span) {
    const file = workspaceFile(cwd, span[1]);
    if (typeof file === "string") return { kind: "unresolved", ref: { ref }, reason: file };
    const start = Number(span[2]), end = Number(span[3] ?? span[2]), all = lines(file.abs);
    if (end < start || end > all.length || end - start + 1 > MAX_SPAN_LINES) return { kind: "unresolved", ref: { ref }, reason: "span_out_of_range" };
    const quote = spanQuote(all, start, end);
    if (!quote.trim()) return { kind: "unresolved", ref: { ref }, reason: "empty_span" };
    return { kind: "span", ref: { ref: `${file.rel}#L${start}-L${end}`, quote } };
  }
  const hash = ref.lastIndexOf("#");
  const file = workspaceFile(cwd, hash > 0 ? ref.slice(0, hash) : ref);
  if (typeof file === "string") return { kind: "unresolved", ref: { ref }, reason: file };
  if (hash > 0) {
    const heading = ref.slice(hash + 1), line = headingLine(lines(file.abs), heading);
    return line ? { kind: "heading", ref: { ref: `${file.rel}#${heading}`, quote: line } } : { kind: "unresolved", ref: { ref }, reason: "heading_missing" };
  }
  return { kind: "path", ref: { ref: file.rel } };
}

export function anchorAnswer(cwd: string, evidence: string, session: { file?: string; entries?: readonly any[] }) {
  const refs = splitEvidence(evidence).slice(0, 16).map(r => resolveAnswerRef(cwd, r, session));
  const verified = refs.some(r => r.kind === "span" || r.kind === "heading" || r.kind === "tool") && refs.every(r => r.kind !== "unresolved");
  return { refs, verified };
}

/** Read-time re-check of a stored answer record's evidence. Tool refs are
 * append-only session entries anchored at write time. */
export function recheckAnswerEvidence(cwd: string, evidence: readonly EvidenceRef[]): { ok: boolean; reason?: string } {
  if (!evidence.length) return { ok: false, reason: "no_evidence" };
  for (const item of evidence) {
    if (/\.jsonl#[^#/]+$/.test(item.ref)) { if (!item.quote) return { ok: false, reason: "tool_quote_missing" }; continue; }
    const hash = item.ref.lastIndexOf("#");
    const file = workspaceFile(cwd, hash > 0 ? item.ref.slice(0, hash) : item.ref, memoryIdentity(cwd).worktree);
    if (typeof file === "string") return { ok: false, reason: `${item.ref}: ${file}` };
    if (hash < 0) continue;
    const all = lines(file.abs), span = /^L(\d+)-L(\d+)$/.exec(item.ref.slice(hash + 1));
    if (span) { if (spanQuote(all, Number(span[1]), Number(span[2])) !== item.quote) return { ok: false, reason: `${item.ref}: span_changed` }; continue; }
    if (headingLine(all, item.ref.slice(hash + 1)) !== item.quote) return { ok: false, reason: `${item.ref}: heading_changed` };
  }
  return { ok: true };
}
