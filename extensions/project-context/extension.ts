import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { withSwarmToolSurface } from "../../.pi/lib/runtime/swarm-tool-surface.ts";
import { wrapToolForHookRows } from "../../.pi/lib/runtime/hook-render-bridge.ts";

// Agent-MCP ask_project_rag over its legacy SSE transport (GET /sse, POST /messages/).
// The server on spark embeds with EmbeddingGemma 2 and returns ranked chunks
// (AGENT_MCP_CHAT_MODEL=none). Chunks are mapped back to local line ranges so
// results are citable as TaskManage evidence.
const DEFAULT_URL = "http://100.84.178.124:8090";
const TOKEN_FILE = join(homedir(), ".config", "agent-mcp", "spark-token");

const schema = {
  type: "object", required: ["query"], additionalProperties: false,
  properties: {
    query: { type: "string", description: "Natural-language question about this project" },
    limit: { type: "integer", minimum: 1, maximum: 13, description: "Chunks to return (default 5)" },
  },
};

/** distance is null for hits found only by the server's BM25 arm (hybrid mode). summary marks Agent-MCP's synthetic per-file code summary. */
interface Chunk { rank: number; distance: number | null; ref: string; content: string; cite?: string; stale?: boolean; summary?: boolean }

function token(): string {
  const env = process.env.PROJECT_CONTEXT_TOKEN?.trim();
  if (env) return env;
  try { return readFileSync(TOKEN_FILE, "utf8").trim(); } catch { throw new Error(`project_context: no token (set PROJECT_CONTEXT_TOKEN or create ${TOKEN_FILE})`); }
}

async function askProjectRag(base: string, query: string, signal: AbortSignal): Promise<string> {
  const ctl = new AbortController();
  const abort = () => ctl.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error("project_context: timed out after 30s")), 30_000);
  try {
    const res = await fetch(new URL("/sse", base), { headers: { accept: "text/event-stream" }, signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`project_context: SSE connect HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let endpoint: string | undefined;
    const replies = new Map<number, any>();
    // Pull SSE events until `done` returns a value.
    const until = async <T>(done: () => T | undefined): Promise<T> => {
      for (;;) {
        const hit = done();
        if (hit !== undefined) return hit;
        const { value, done: eof } = await reader.read();
        if (eof) throw new Error("project_context: SSE stream closed");
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? "message";
          const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (event === "endpoint") endpoint = new URL(data, base).href;
          else if (data) { const msg = JSON.parse(data); if (typeof msg.id === "number") replies.set(msg.id, msg); }
        }
      }
    };
    await until(() => endpoint);
    let nextId = 0;
    const send = async (method: string, params: unknown, notify = false) => {
      const id = notify ? undefined : ++nextId;
      const r = await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id ? { id } : {}) }), signal: ctl.signal });
      if (!r.ok) throw new Error(`project_context: ${method} HTTP ${r.status}`);
      if (!id) return undefined;
      const msg = await until(() => replies.get(id));
      if (msg.error) throw new Error(`project_context: ${method}: ${msg.error.message ?? "MCP error"}`);
      return msg.result;
    };
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trebol-project-context", version: "1" } });
    await send("notifications/initialized", {}, true);
    const result = await send("tools/call", { name: "ask_project_rag", arguments: { token: token(), query } });
    const text = result?.content?.map((c: any) => c?.text ?? "").join("\n") ?? "";
    if (result?.isError || /^(Unauthorized|RAG Error|Error )/.test(text)) throw new Error(`project_context: ${text.slice(0, 300)}`);
    return text;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    ctl.abort();
  }
}

function parseChunks(text: string): Chunk[] {
  const out: Chunk[] = [];
  const re = /Retrieved Chunk (\d+) \(Similarity\/Distance: ([\d.]+|None|N\/A)\):\nSource Type: [^,\n]*, Reference: ([^\n,]+)[^\n]*\nContent:\n([\s\S]*?)(?=\n\nRetrieved Chunk \d+ |\n-{20,}|$)/g;
  for (const m of text.matchAll(re)) {
    const ref = m[3].trim(), content = m[4].trim();
    out.push({ rank: +m[1], distance: /^[\d.]+$/.test(m[2]) ? +m[2] : null, ref, content, summary: content.startsWith(`File: ${ref}\n{`) });
  }
  return out;
}

/** Locate the chunk in the local checkout. Chunks are cut mid-line, so boundary lines are fragments: match by substring. */
function cite(cwd: string, chunk: Chunk): void {
  const path = resolve(cwd, chunk.ref);
  if (!path.startsWith(resolve(cwd) + sep)) return;
  let file: string;
  try { file = readFileSync(path, "utf8"); } catch { chunk.stale = true; return; }
  if (chunk.summary) { chunk.cite = chunk.ref; return; }
  const lines = file.split("\n");
  const probe = chunk.content.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12);
  const anchor = probe[0];
  if (!anchor) { chunk.cite = chunk.ref; return; }
  const second = probe[1];
  const start = lines.findIndex((l, i) => l.includes(anchor) && (!second || lines.slice(i + 1, i + 4).some((n) => n.includes(second))));
  if (start < 0) { chunk.stale = true; chunk.cite = chunk.ref; return; }
  const last = probe[probe.length - 1];
  let end = start;
  for (let i = start; i < lines.length && i < start + 200; i++) if (lines[i].includes(last)) { end = i; break; }
  chunk.cite = `${chunk.ref}#L${start + 1}-L${end + 1}`;
}

function render(query: string, chunks: Chunk[]): string {
  if (chunks.length === 0) return `No indexed project context matched: ${query}`;
  const rows = chunks.map((c) => {
    const flag = c.stale ? " (local file differs from index; re-sync spark corpus)" : "";
    const score = c.distance === null ? "keyword match" : `distance=${c.distance.toFixed(3)}`;
    return `[${c.rank}] ${c.cite ?? c.ref} ${c.summary ? "file summary " : ""}${score}${flag}\n${c.content}`;
  });
  return `project_context (Agent-MCP ask_project_rag, EmbeddingGemma 2) for: ${query}\nCite the bracketed path as evidence after reading it.\n\n${rows.join("\n\n")}`;
}

export default function projectContextExtension(rawPi: any) {
  const pi = withSwarmToolSurface(rawPi);
  pi.registerTool(wrapToolForHookRows({
    name: "project_context", label: "Project Context",
    description: "Hybrid semantic + keyword search over this repository's markdown and TypeScript/JS source via Agent-MCP ask_project_rag (EmbeddingGemma 2 on spark). Returns ranked chunks with citable path#Lx-Ly references. Read-only.",
    parameters: schema,
    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("project_context: query is required");
      const limit = Math.min(13, Math.max(1, Number(params?.limit) || 5));
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
      const raw = await askProjectRag(process.env.PROJECT_CONTEXT_URL || DEFAULT_URL, query, signal);
      const chunks = parseChunks(raw).slice(0, limit);
      for (const c of chunks) cite(cwd, c);
      const details = { query, chunks: chunks.map(({ content, ...rest }) => rest) };
      return { content: [{ type: "text", text: render(query, chunks) }], details };
    },
  }));
}
