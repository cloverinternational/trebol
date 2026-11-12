// Structural host/test adapters intentionally accept heterogeneous event and tool payloads; runtime guards narrow the fields used here.
import { createHash } from "node:crypto";
import { hookTelemetry } from "../../.pi/lib/runtime/hook-state.ts";
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
/** Where `current` stops extending `previous`: providers cache only an unchanged prefix, so the first differing message is what re-bills everything after it. */
export function prefixBreak(previous: any, current: any): { index: number; role?: string; at: number; was: string; now: string } | undefined {
  const msgs = (p: any): unknown[] => [{ system: p?.system, tools: p?.tools }, ...(Array.isArray(p?.messages) ? p.messages : Array.isArray(p?.input) ? p.input : [])];
  const a = msgs(previous), b = msgs(current);
  for (let i = 0; i < a.length; i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x === y) continue;
    let at = 0; while (at < x.length && x[at] === (y ?? "")[at]) at++;
    return { index: i - 1, role: (b[i] as any)?.role ?? (a[i] as any)?.role, at, was: x.slice(Math.max(0, at - 60), at + 120), now: (y ?? "<missing>").slice(Math.max(0, at - 60), at + 120) };
  }
  return undefined;
}
export default function cacheTelemetry(pi: any) {
  let previous = "", previousPayload: unknown, calls = 0;
  pi.on("before_provider_request", (e: any) => { const current = hash(e.payload); const changed = !!previous && previous !== current; calls++; const prefix = previousPayload === undefined ? undefined : prefixBreak(previousPayload, e.payload); pi.appendEntry("pi-swarm-cache-telemetry", { at: new Date().toISOString(), calls, requestHash: current, previousHash: previous || undefined, requestChanged: changed, prefixBreak: prefix, hook: hookTelemetry().counts }); previous = current; previousPayload = structuredClone(e.payload); });
  pi.on("after_provider_response", (e: any) => pi.appendEntry("pi-swarm-cache-response", { at: new Date().toISOString(), status: e.status, headers: Object.keys(e.headers ?? {}) }));
  pi.registerCommand?.("cache", { description: "Show provider cache telemetry", handler: async (_args: string, ctx: any) => { const entries = ctx.sessionManager?.getEntries?.() ?? []; const rows = entries.filter((x: any) => x.type === "pi-swarm-cache-telemetry"); const hits = rows.filter((x: any) => x.data?.requestChanged === false).length; ctx.ui?.notify?.(`Cache telemetry: ${rows.length} requests, ${hits} stable request payloads, ${rows.length - hits} changed payloads. Check provider usage cacheRead/cacheWrite for actual cache hits.`, "info"); } });
}
