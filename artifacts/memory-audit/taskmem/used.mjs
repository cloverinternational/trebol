// Count TaskManage-derived record ids that appear in any session tool result (retrieval), across all workspaces.
import { readdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path"; import { homedir } from "node:os";
const root = join(homedir(), ".swarm/memory/knowledge"); const ids = new Map();
const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".json")) { try { const e = JSON.parse(readFileSync(p, "utf8")); const s = e.record.source; ids.set(e.record.id, s.startsWith("taskmanage:") ? "taskmanage" : s.split(":")[0]); } catch {} } } };
walk(root);
const sroot = join(homedir(), ".pi/agent/sessions"); const hits = new Map(); let files = 0, results = 0; const skipped = [];
const re = /\b[a-f0-9]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
for (const ws of readdirSync(sroot)) { const d = join(sroot, ws); if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d).filter(n => n.endsWith(".jsonl"))) { files++;
    if (statSync(join(d, f)).size > 400e6) { skipped.push(`${ws}/${f}`); continue; }
    for await (const line of createInterface({ input: createReadStream(join(d, f), "utf8"), crlfDelay: Infinity })) {
      if (!line.includes('"toolResult"')) continue; let e; try { e = JSON.parse(line); } catch { continue; }
      const m = e.message; if (m?.role !== "toolResult" || !["memory_history", "bootstrap"].includes(m.toolName)) continue; results++;
      const txt = JSON.stringify(m.content); for (const id of new Set(txt.match(re) ?? [])) if (ids.has(id)) { const k = ids.get(id); const h = hits.get(k) ?? { ids: new Set(), results: 0 }; h.ids.add(id); h.results++; hits.set(k, h); } } } }
const per = {}; for (const [k, v] of ids) per[v] = (per[v] ?? 0) + 1;
const uniq = new Map(); for (const [id, k] of ids) uniq.set(id, k);
const tot = {}; for (const k of uniq.values()) tot[k] = (tot[k] ?? 0) + 1;
console.log(JSON.stringify({ sessionFiles: files, skipped, memoryOrBootstrapResults: results, recordsBySource: tot,
  retrieved: Object.fromEntries([...hits].map(([k, v]) => [k, { distinctRecords: v.ids.size, resultMentions: v.results }])) }, null, 1));
