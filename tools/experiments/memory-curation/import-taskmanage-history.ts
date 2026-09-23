/** Live TaskManage journal backfill. Run with esbuild-bundled Node; no fixtures. */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { captureTaskCandidates } from "../../../.pi/lib/state/task-candidate-capture.ts";
import { openKnowledgeStore } from "../../../.pi/lib/state/knowledge-store.ts";

const cwd = process.cwd();
const dir = join(homedir(), ".pi", "agent", "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
const outDir = join(cwd, ".swarmpi", "task-memory-import");
mkdirSync(outDir, { recursive: true });
// A completed report is a durable session checkpoint. Without this, replaying
// every historical Q&A revision would rewind each current record and append
// the same revision chain again, even though the latest snapshot matches.
const completed = new Set<string>();
for (const report of readdirSync(outDir).filter(name => /^import-\d+\.jsonl$/.test(name))) {
  try {
    const rows = readFileSync(join(outDir, report), "utf8").trimEnd().split("\n").map(row => JSON.parse(row));
    if (rows.at(-1)?.phase === "finish") for (const row of rows) if (row.phase === "import" && typeof row.session === "string") completed.add(row.session);
  } catch { /* an incomplete report is not a checkpoint */ }
}
const lines: string[] = [];
const put = (entry: unknown) => lines.push(JSON.stringify(entry));
const now = new Date().toISOString();
put({ phase: "start", at: now, sessionsDir: dir });
let sessions = 0, snapshots = 0, selected = 0, saved = 0, unchanged = 0, failed = 0;
for (const name of readdirSync(dir).filter(n => n.endsWith(".jsonl")).sort()) {
  if (completed.has(name)) continue;
  const path = join(dir, name);
  const snapshotsForSession: { revision: number; tasks: any[]; line: number }[] = [];
  for (const [index, raw] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!raw.includes('"pi-swarm-task-state"')) continue;
    let row: any;
    try { row = JSON.parse(raw); } catch { continue; }
    if (row?.type !== "custom" || row.customType !== "pi-swarm-task-state") continue;
    const state = row.data?.state ?? row.data;
    if (!Array.isArray(state?.tasks)) continue;
    snapshotsForSession.push({ revision: Number(row.data?.revision) || 0, tasks: state.tasks, line: index + 1 });
  }
  if (!snapshotsForSession.length) continue;
  sessions++; snapshots += snapshotsForSession.length;
  // Keep changes to task Q&A, plus the last complete snapshot. This avoids
  // task-audit-event churn while retaining question/answer revisions.
  const previous = new Map<string, string>();
  const versions: { task: any; revision: number; line: number }[] = [];
  for (const snapshot of snapshotsForSession) for (const task of snapshot.tasks) {
    if (!task || typeof task.id !== "string") continue;
    const fingerprint = createHash("sha256").update(JSON.stringify([task.subject, task.description, task.questions, task.answers])).digest("hex");
    if (previous.get(task.id) !== fingerprint) {
      previous.set(task.id, fingerprint);
      versions.push({ task, revision: snapshot.revision, line: snapshot.line });
    }
  }
  const latest = snapshotsForSession.at(-1)!;
  for (const task of latest.tasks) {
    if (!task || typeof task.id !== "string") continue;
    if (!versions.some(v => v.task.id === task.id && v.revision === latest.revision)) versions.push({ task, revision: latest.revision, line: latest.line });
  }
  for (const version of versions) {
    selected++;
    const result = captureTaskCandidates({ cwd, session: path, tasks: [version.task] });
    saved += result.saved.length; unchanged += result.unchanged.length; failed += result.failed.length;
    put({ phase: "import", session: name, line: version.line, journalRevision: version.revision,
      taskId: version.task.id, subject: String(version.task.subject ?? "").slice(0, 130),
      questions: version.task.questions?.length ?? 0, answers: version.task.answers?.length ?? 0,
      saved: result.saved.map(r => ({ id: r.id, revision: r.revision, status: r.status, scope: r.scope })),
      unchanged: result.unchanged, failed: result.failed });
  }
  if (sessions % 10 === 0) console.error(`imported ${sessions} sessions, ${selected} task versions, ${saved} writes`);
}
const store = openKnowledgeStore({ cwd, scope: "worktree" });
const records = store.snapshot().filter(r => r.source.startsWith("taskmanage:"));
put({ phase: "finish", at: new Date().toISOString(), sessions, snapshots, selected, saved, unchanged, failed,
  currentCandidates: records.filter(r => r.status === "candidate").length,
  samples: records.slice(-5).map(r => ({ id: r.id, status: r.status, scope: r.scope, source: basename(r.source.split(":")[1] ?? ""),
    taskId: JSON.parse(r.text).taskId, subject: JSON.parse(r.text).subject, questions: JSON.parse(r.text).questions.slice(0, 2) })) });
const report = join(outDir, `import-${Date.now()}.jsonl`);
writeFileSync(report, lines.join("\n") + "\n", { mode: 0o600 });
console.log(JSON.stringify({ report, sessions, snapshots, selected, saved, unchanged, failed, currentCandidates: records.filter(r => r.status === "candidate").length }));
