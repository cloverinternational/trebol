/** Only these snapshot-backed read tools exist in the isolated retrieval Pi. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export default function memoryRetrievalWorker(pi: any) {
  if (process.env.PI_SWARM_MEMORY_RETRIEVAL_WORKER !== "1" || process.env.PI_SWARM_SUBAGENT !== "1") throw new Error("Isolated memory retrieval only");
  const snapshot = resolve(process.env.PI_SWARM_MEMORY_RETRIEVAL_SNAPSHOT ?? "");
  const receipt = resolve(process.env.PI_SWARM_MEMORY_RETRIEVAL_RECEIPT ?? "");
  if (!process.env.PI_SWARM_MEMORY_RETRIEVAL_SNAPSHOT || !process.env.PI_SWARM_MEMORY_RETRIEVAL_RECEIPT || snapshot === receipt || dirname(snapshot) !== dirname(receipt)) throw new Error("Memory retrieval snapshot and colocated receipt required");
  const input = JSON.parse(readFileSync(snapshot, "utf8"));
  if (!Array.isArray(input.cards) || input.cards.length > 12 || input.cards.some((x: any) => typeof x.key !== "string" || typeof x.excerpt !== "string")) throw new Error("Invalid memory retrieval snapshot");
  const maxReturn = Number.isInteger(input.maxReturn) && input.maxReturn >= 1 && input.maxReturn <= 5 ? input.maxReturn : 5;
  let calls = 0, submitted = false;
  const read = new Set<string>();
  const gate = () => { if (++calls > 8) throw new Error("Memory retrieval tool budget exhausted"); };
  const out = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {} });
  pi.on?.("session_start", () => pi.setActiveTools?.(["memory_browse", "memory_read", "memory_select"]));
  pi.on?.("tool_call", (event: any) => {
    if (!["memory_browse", "memory_read", "memory_select"].includes(event.toolName)) return { block: true, reason: "Only snapshot-backed memory read tools are available" };
  });
  pi.registerTool?.({ name: "memory_browse", label: "Browse memory", description: "List bounded task-relevant source cards with status and scope; no body text.", parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { gate(); return out({ cards: input.cards.map(({ key, id, revision, status, scope, title }: any) => ({ key, id, revision, status, scope, title })) }); } });
  pi.registerTool?.({ name: "memory_read", label: "Read memory", description: "Read a source card by its exact key, including candidate status and original evidence.", parameters: { type: "object", required: ["key"], properties: { key: { type: "string" } }, additionalProperties: false },
    async execute(_id: string, params: any) { gate(); const card = input.cards.find((one: any) => one.key === params.key); if (card) read.add(card.key); return out(card ?? { error: "Unknown memory key" }); } });
  pi.registerTool?.({ name: "memory_select", label: "Return memory", description: `Submit at most ${maxReturn} directly supporting cards. Set supported=false with an empty selection when none answer the query; this does not verify or write memory.`,
    parameters: { type: "object", required: ["supported", "selected", "note"], additionalProperties: false, properties: { supported: { type: "boolean" }, selected: { type: "array", maxItems: maxReturn, items: { type: "object", required: ["key", "why"], properties: { key: { type: "string" }, why: { type: "string" } }, additionalProperties: false } }, note: { type: "string" } } },
    async execute(_id: string, params: any) {
      gate(); if (submitted) return out({ error: "Selection already submitted" });
      if (typeof params.supported !== "boolean" || !Array.isArray(params.selected) || params.selected.length > maxReturn || params.supported !== (params.selected.length > 0) || typeof params.note !== "string" || params.note.length > 400 ||
        new Set(params.selected.map((one: any) => one.key)).size !== params.selected.length ||
        params.selected.some((one: any) => !input.cards.some((card: any) => card.key === one.key) || !read.has(one.key) || typeof one.why !== "string" || one.why.length > 240)) return out({ error: "Invalid selected keys, unread card, or explanation" });
      submitted = true;
      writeFileSync(receipt, JSON.stringify({ supported: params.supported, selected: params.selected, note: params.note }), { flag: "wx", mode: 0o600 });
      return out({ submitted: true, selected: params.selected.map((one: any) => one.key) });
    } });
}
