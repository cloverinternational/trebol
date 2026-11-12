#!/usr/bin/env node
/**
 * Builds the cache-break SVGs from raw data only and refuses to write charts whose totals
 * do not match raw sums.
 *   node tools/cache-report/report.mjs <session.jsonl> [lastLine]
 * Inputs: the session JSONL (provider-reported usage), artifacts/cache-report/raw/{ab,upstream}.json.
 * Output: artifacts/cache-report/*.svg + data.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [sessionFile, lastLineArg] = process.argv.slice(2);
const OUT = join(process.cwd(), "artifacts/cache-report");
mkdirSync(OUT, { recursive: true });
const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
const rows = (lastLineArg ? lines.slice(0, Number(lastLineArg)) : lines).map((l) => JSON.parse(l));

// ---- classify every provider call from raw usage ----
const CAUSES = ["growth", "first-after-prompt", "compaction", "mid-turn-full-miss", "partial-miss", "session-start"];
const calls = [];
let prev = 0, sawUser = false, sawComp = false, n = 0;
for (const r of rows) {
  if (r.type === "compaction") sawComp = true;
  if (r.type === "message" && r.message?.role === "user") sawUser = true;
  const m = r.message;
  if (r.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
  const u = m.usage, prompt = u.input + u.cacheRead + u.cacheWrite;
  if (!prompt) continue;
  n++;
  let cls, lost = 0;
  if (!prev) cls = "session-start";
  else {
    lost = Math.min(u.input, Math.max(0, prev - u.cacheRead));
    if (sawComp) cls = "compaction";
    else if (sawUser) cls = "first-after-prompt";
    else if (u.cacheRead === 0) cls = "mid-turn-full-miss";
    else if (lost > 2048) cls = "partial-miss";
    else cls = "warm";
  }
  const start = cls === "session-start";
  calls.push({ n, at: r.timestamp, input: u.input, cacheRead: u.cacheRead, prompt, cls, lost: start ? 0 : lost, growth: start ? 0 : u.input - lost, startTokens: start ? u.input : 0 });
  prev = prompt; sawUser = false; sawComp = false;
}

// ---- reconciliation: every uncached token is assigned to exactly one bucket ----
const rawInput = calls.reduce((s, c) => s + c.input, 0);
const rawCached = calls.reduce((s, c) => s + c.cacheRead, 0);
const byCause = Object.fromEntries(CAUSES.map((k) => [k, 0]));
for (const c of calls) {
  byCause.growth += c.growth;
  byCause["session-start"] += c.startTokens;
  if (c.lost) byCause[c.cls === "warm" ? "partial-miss" : c.cls] += c.lost;
}
const assigned = Object.values(byCause).reduce((a, b) => a + b, 0);
if (assigned !== rawInput) { console.error(`RECONCILE FAIL: assigned ${assigned} != raw input ${rawInput}`); process.exit(1); }

// ---- svg helpers ----
const C = { cached: "#3b82f6", uncached: "#ef4444", growth: "#94a3b8", "first-after-prompt": "#f59e0b", compaction: "#8b5cf6", "mid-turn-full-miss": "#ef4444", "partial-miss": "#f97316", "session-start": "#64748b", ink: "#0f172a", grid: "#e2e8f0", muted: "#64748b", ok: "#16a34a" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmt = (v) => (v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(v));
const svg = (w, h, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-sans-serif,system-ui,sans-serif"><rect width="${w}" height="${h}" fill="#fff"/><text x="24" y="32" font-size="18" font-weight="600" fill="${C.ink}">${esc(title)}</text>${body}</svg>`;
const legend = (x, y, items) => items.map(([label, color], i) => `<rect x="${x + i * 190}" y="${y - 10}" width="12" height="12" fill="${color}"/><text x="${x + i * 190 + 18}" y="${y}" font-size="12" fill="${C.ink}">${esc(label)}</text>`).join("");
const write = (name, s) => writeFileSync(join(OUT, name), s);
const yAxis = (x0, y0, h, max, w) => [0, 0.25, 0.5, 0.75, 1].map((f) => { const y = y0 - f * h; return `<line x1="${x0}" x2="${x0 + w}" y1="${y}" y2="${y}" stroke="${C.grid}"/><text x="${x0 - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="${C.muted}">${fmt(Math.round(max * f))}</text>`; }).join("");

// 1. timeline
{
  const W = 1200, H = 460, x0 = 70, y0 = 380, ph = 300, pw = W - x0 - 30;
  const max = Math.max(...calls.map((c) => c.prompt));
  const bw = pw / calls.length;
  let b = yAxis(x0, y0, ph, max, pw);
  for (const [i, c] of calls.entries()) {
    const x = x0 + i * bw, hc = (c.cacheRead / max) * ph, hu = (c.input / max) * ph, w = Math.max(bw - 0.3, 0.6).toFixed(2);
    b += `<rect x="${x.toFixed(2)}" y="${(y0 - hc).toFixed(2)}" width="${w}" height="${hc.toFixed(2)}" fill="${C.cached}"/>`;
    b += `<rect x="${x.toFixed(2)}" y="${(y0 - hc - hu).toFixed(2)}" width="${w}" height="${hu.toFixed(2)}" fill="${C.uncached}"/>`;
    const mark = c.cls === "first-after-prompt" ? C["first-after-prompt"] : c.cls === "compaction" ? C.compaction : c.cls === "mid-turn-full-miss" ? C.ink : null;
    if (mark) b += `<path d="M${(x + bw / 2).toFixed(2)} ${y0 + 8} l-5 9 h10 z" fill="${mark}"/>`;
  }
  b += `<text x="${x0}" y="${y0 + 36}" font-size="11" fill="${C.muted}">provider call #1 … #${calls.length} (${calls[0].at.slice(11, 16)}–${calls.at(-1).at.slice(11, 16)} UTC)</text>`;
  b += legend(x0, 60, [["cached (cacheRead)", C.cached], ["uncached (input)", C.uncached], ["▲ first call after prompt", C["first-after-prompt"]], ["▲ compaction", C.compaction], ["▲ mid-turn full miss", C.ink]]);
  write("1-timeline.svg", svg(W, H, b, "Every provider call: cached vs uncached prompt tokens"));
}

// 2. lost by cause
{
  const order = ["mid-turn-full-miss", "first-after-prompt", "compaction", "growth", "partial-miss", "session-start"];
  const labels = { "mid-turn-full-miss": "Mid-turn full miss (cached=0)", "first-after-prompt": "First call after a user prompt", compaction: "Compaction (expected reset)", growth: "New content (unavoidable)", "partial-miss": "Mid-turn partial miss", "session-start": "Session start (cold)" };
  const W = 900, H = 110 + order.length * 46, x0 = 270, bwMax = W - x0 - 140, max = Math.max(...order.map((k) => byCause[k]));
  let b = "";
  order.forEach((k, i) => {
    const y = 60 + i * 46, w = (byCause[k] / max) * bwMax;
    b += `<text x="${x0 - 10}" y="${y + 19}" font-size="13" text-anchor="end" fill="${C.ink}">${esc(labels[k])}</text><rect x="${x0}" y="${y + 4}" width="${w.toFixed(1)}" height="22" fill="${C[k]}"/><text x="${x0 + w + 8}" y="${y + 20}" font-size="12" fill="${C.ink}">${fmt(byCause[k])} (${((byCause[k] / rawInput) * 100).toFixed(1)}%)</text>`;
  });
  b += `<text x="24" y="${H - 14}" font-size="11" fill="${C.ok}">reconciled: buckets sum ${assigned.toLocaleString("en-US")} = raw uncached input ${rawInput.toLocaleString("en-US")}</text>`;
  write("2-lost-by-cause.svg", svg(W, H, b, "Where the uncached prompt tokens came from"));
}

// 3. A/B
const ab = JSON.parse(readFileSync(join(OUT, process.env.AB_FILE ?? "raw/ab-before.json"), "utf8"));
{
  const W = 1020, H = 400, max = Math.max(...[...ab.on.calls, ...ab.off.calls].map((c) => c.input + c.cacheRead));
  let b = "";
  [ab.on, ab.off].forEach((arm, ai) => {
    const ox = 60 + ai * 490, y0 = 300, ph = 190, bw = 70;
    b += `<text x="${ox}" y="70" font-size="14" font-weight="600" fill="${C.ink}">git_status ${arm.gitStatusEnabled ? "ON (default)" : "OFF"}</text>`;
    arm.calls.forEach((c, i) => {
      const x = ox + i * (bw + 40), hc = (c.cacheRead / max) * ph, hu = (c.input / max) * ph;
      b += `<rect x="${x}" y="${y0 - hc}" width="${bw}" height="${hc}" fill="${C.cached}"/><rect x="${x}" y="${y0 - hc - hu}" width="${bw}" height="${hu}" fill="${C.uncached}"/>`;
      b += `<text x="${x + bw / 2}" y="${y0 + 16}" font-size="11" text-anchor="middle" fill="${C.ink}">prompt ${i + 1}</text><text x="${x + bw / 2}" y="${y0 + 30}" font-size="10" text-anchor="middle" fill="${C.muted}">cached ${fmt(c.cacheRead)}</text>`;
      if (c.prefixBreak) b += `<text x="${x + bw / 2}" y="${y0 + 44}" font-size="10" text-anchor="middle" fill="${c.prefixBreak.role === "system" ? C.uncached : C.muted}">break: ${c.prefixBreak.role} @${c.prefixBreak.at}</text>`;
    });
    const lx = ox + 2 * (bw + 40) - 20;
    b += `<line x1="${lx}" x2="${lx}" y1="84" y2="${y0}" stroke="${C.ink}" stroke-dasharray="4 3"/><text x="${lx + 4}" y="96" font-size="10" fill="${C.ink}">changed.txt written</text>`;
  });
  b += legend(60, 375, [["cached", C.cached], ["uncached", C.uncached]]);
  write("3-ab-gitstatus.svg", svg(W, H, b, "A/B: same repo change between prompts 2 and 3"));
}

// 4. upstream
const up = JSON.parse(readFileSync(join(OUT, "raw/upstream.json"), "utf8"));
const upCalls = up.calls.map((c) => ({ k: c.k, cached: c.usage?.prompt_tokens_details?.cached_tokens ?? 0, prompt: c.usage?.prompt_tokens ?? 0 }));
const upWarm = upCalls.slice(1), upMiss = upWarm.filter((c) => c.cached === 0);
{
  const W = 1000, H = 300, x0 = 70, y0 = 230, ph = 150, pw = W - x0 - 30, bw = pw / upCalls.length, max = Math.max(...upCalls.map((c) => c.prompt));
  let b = yAxis(x0, y0, ph, max, pw);
  upCalls.forEach((c, i) => {
    const x = x0 + i * bw, hc = (c.cached / max) * ph, hu = ((c.prompt - c.cached) / max) * ph;
    b += `<rect x="${x}" y="${y0 - hc}" width="${bw - 2}" height="${hc}" fill="${C.cached}"/><rect x="${x}" y="${y0 - hc - hu}" width="${bw - 2}" height="${hu}" fill="${C.uncached}"/>`;
  });
  b += `<text x="${x0}" y="${y0 + 22}" font-size="12" fill="${C.ink}">${upCalls.length} calls, each the previous request plus one message. Full misses after warm-up: ${upMiss.length}/${upWarm.length} (calls ${upMiss.map((c) => c.k).join(", ")})</text>`;
  b += legend(x0, 62, [["cached", C.cached], ["uncached", C.uncached]]);
  write("4-upstream-drops.svg", svg(W, H, b, "Upstream: identical growing prefix, no client in the loop"));
}

const data = { sessionFile, lastLine: lastLineArg ? Number(lastLineArg) : lines.length, calls: calls.length, rawInput, rawCached, hitRate: rawCached / (rawCached + rawInput), byCause, classCounts: Object.fromEntries([...new Set(calls.map((c) => c.cls))].map((k) => [k, calls.filter((c) => c.cls === k).length])), ab: { on: ab.on.calls, off: ab.off.calls }, upstream: { calls: upCalls.length, warm: upWarm.length, fullMisses: upMiss.length } };
writeFileSync(join(OUT, "data.json"), JSON.stringify(data, null, 2));
console.log(JSON.stringify({ calls: data.calls, rawInput, rawCached, hitRate: (data.hitRate * 100).toFixed(1) + "%", byCause, classCounts: data.classCounts, upstream: data.upstream }, null, 1));
