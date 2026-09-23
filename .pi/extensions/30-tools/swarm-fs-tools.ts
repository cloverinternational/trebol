import { applyPatch, undoFile } from "../../lib/tools/swarm-apply-patch.ts";
import { readImage } from "../../lib/tools/swarm-read-image.ts";
import { newErrorID } from "../../lib/tools/swarm-bash.ts";
import { applySwarmSurface } from "../../lib/runtime/swarm-tool-surface.ts";
import { APPLY_PATCH_CONTRACT, READ_CONTRACT, UNDO_CONTRACT } from "../../lib/tools/swarm-fs-tools.contract.ts";

type Pi = any;
const registrations = new WeakSet<object>();
// Pi flags a tool result as failed only when execute() throws; the message
// becomes the result content verbatim (docs/extensions.md "Signaling errors").
const error = (name: string, message: string): never => {
  throw new Error(`Error executing ${name}: ${message} (error_id=${newErrorID()})`);
};

export function registerSwarmFSTools(pi: Pi): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);
  // Snapshot provenance published by the transport extension
  // (conversation id + the user turn as the model saw it).
  const provenance = () => ({
    conversationId: (globalThis as any)[Symbol.for("pi-swarm-conversation-id")] as string | undefined,
    userMessage: (globalThis as any)[Symbol.for("pi-swarm-last-user-message")] as string | undefined,
  });
  // Headless sessions auto-approve file reads; the interactive TUI would
  // prompt the user, so only headless sessions skip Read's workspace boundary.
  let headless = false;
  pi.on?.("session_start", (_event: unknown, ctx: any) => { headless = ctx?.hasUI === false; });
  // Validation failures carry the tool's own prose, wrapped once more.
  const validation = (name: string, message: string): never =>
    error(name, `validation failed for ${name}: ${message} (error_id=${newErrorID()})`);
  pi.registerTool?.(applySwarmSurface({
    name: "apply_patch", label: "apply_patch", ...APPLY_PATCH_CONTRACT,
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      try {
        const text = await applyPatch(params?.input, { workspacePath: ctx?.cwd ?? pi.getCwd?.() ?? process.cwd(), cwd: params?.cwd, signal, ...provenance() });
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) { return error("apply_patch", (e as Error).message); }
    },
  }));
  pi.registerTool?.(applySwarmSurface({
    name: "Undo", label: "Undo", ...UNDO_CONTRACT,
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      try {
        const text = await undoFile(params?.path, ctx?.cwd ?? pi.getCwd?.() ?? process.cwd());
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) { return error("Undo", (e as Error).message); }
    },
  }));
  pi.registerTool?.(applySwarmSurface({
    name: "Read", label: "Read", ...READ_CONTRACT,
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      const filePath = params?.file_path ?? params?.file ?? params?.path ?? params?.filename;
      if (filePath === undefined || filePath === null) return validation("Read", "file_path is required");
      if (typeof filePath !== "string") return validation("Read", "file_path must be a string");
      try {
        const content = readImage(filePath, ctx?.cwd ?? pi.getCwd?.() ?? process.cwd(), headless);
        return { content, details: {} };
      } catch (e) { return error("Read", (e as Error).message); }
    },
  }));
}

export default function swarmFSToolsExtension(pi: Pi): void { registerSwarmFSTools(pi); }
