// Read-only census of ~/.swarm/memory/knowledge event files.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const root = join(homedir(), ".swarm/memory/knowledge");
const latest = new Map(); let events = 0;
for (const scope of readdirSync(root)) {
  const sd = join(root, scope); if (!statSync(sd).isDirectory()) continue;
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".json")) {
    let e; try { e = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    if (!e?.record?.id) continue; events++;
    const key = `${scope}|${p.slice(sd.length).split("/")[1]}|${e.record.id}`;
    const prev = latest.get(key); if (!prev || n > prev.file) latest.set(key, { file: n, dir: p.slice(sd.length).split("/")[1], scope, e, revs: (prev?.revs ?? 0) + 1 }); else prev.revs++;
  } } };
  walk(sd);
}
const fam = s => s.startsWith("taskmanage:") ? "taskmanage" : s.split(":")[0] || "(none)";
const rows = [...latest.values()].filter(r => !r.e.record.deleted);
const tab = {};
for (const r of rows) { const k = `${fam(r.e.record.source)}|${r.e.record.status}`; tab[k] = (tab[k] ?? 0) + 1; }
console.log(JSON.stringify({ events, liveRecords: rows.length, deleted: latest.size - rows.length }));
console.log(Object.entries(tab).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}\t${v}`).join("\n"));
const tm = rows.filter(r => r.e.record.source.startsWith("taskmanage:"));
let q = 0, a = 0, refs = { file: 0, tool: 0, other: 0 }, completed = 0, withAns = 0; const subj = new Map();
const revs = tm.map(r => r.revs).sort((x, y) => x - y);
for (const r of tm) { let c; try { c = JSON.parse(r.e.record.text); } catch { continue; }
  if (c.status === "completed") completed++;
  q += c.questions.length; const ans = c.questions.filter(x => x.answer); a += ans.length; if (ans.length) withAns++;
  for (const x of ans) for (const ref of x.evidence.split(/[;,]\s*/).filter(Boolean)) /^tool:/.test(ref.trim()) ? refs.tool++ : /[\w.-]+\/|\.\w+(#|$)/.test(ref) ? refs.file++ : refs.other++;
  const s = c.subject.toLowerCase().replace(/\s+/g, " ").trim(); subj.set(s, (subj.get(s) ?? 0) + 1); }
const dupRecs = [...subj.values()].filter(v => v > 1).reduce((s, v) => s + v, 0);
console.log(JSON.stringify({ taskmanageRecords: tm.length, completedTasks: completed, tasksWithAnswers: withAns, questions: q, answers: a, evidenceRefs: refs,
  dirs: [...new Set(tm.map(r => `${r.scope}/${r.dir}`))], revisionsMedian: revs[Math.floor(revs.length / 2)], revisionsMax: revs.at(-1),
  distinctSubjects: subj.size, recordsSharingSubject: dupRecs, verifiedTaskmanage: tm.filter(r => r.e.record.status === "verified").length }));
