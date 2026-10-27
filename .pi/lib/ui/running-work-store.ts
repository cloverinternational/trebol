// Dependency-free store for background work (bash and subagent). Imported by the Pi-side UI and by the
// Tern bridge, so it must not import Pi TUI modules or TypeScript-only syntax.
export type RunningWorkKind = "subagent" | "bash";
export type RunningWorkStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunningWorkItem {
  id: string;
  kind: RunningWorkKind;
  label: string;
  status: RunningWorkStatus;
  startedAt: number;
  endedAt?: number;
  tokens?: number;
  detail: string;
  output?: string;
  /** Live snapshot of the process output; used while the work is still running. */
  readOutput?: () => string;
  transcriptPath?: string;
  /** Stops the work while it runs; writers drop it once the work settles. */
  stop?: () => void;
  /** True while a tool call is still waiting on this work in the foreground; cleared when it is backgrounded. */
  foreground?: boolean;
}

const KEY = Symbol.for("pi-swarm-running-work");
type State = { items: Map<string, RunningWorkItem>; listeners: Set<() => void>; expanded: boolean; selected: number; sessionId?: string };
export const state = (): State => {
  const root = globalThis as typeof globalThis & { [KEY]?: State };
  return root[KEY] ?? (root[KEY] = { items: new Map(), listeners: new Set(), expanded: false, selected: 0 });
};

export function runningWorkSnapshot(): RunningWorkItem[] { return [...state().items.values()].sort((a, b) => a.startedAt - b.startedAt); }
export function setRunningWork(item: RunningWorkItem): void { state().items.set(item.id, { ...item }); state().listeners.forEach(listener => listener()); }
export function patchRunningWork(id: string, patch: Partial<RunningWorkItem>): void { const item = state().items.get(id); if (item) setRunningWork({ ...item, ...patch }); }
export function removeRunningWork(id: string): void { state().items.delete(id); state().listeners.forEach(listener => listener()); }
export function onRunningWorkChange(listener: () => void): () => void { state().listeners.add(listener); return () => state().listeners.delete(listener); }
