/** A small, deliberately non-blocking budget for prompting memory queries. */

export interface MemoryQueryBudgetSnapshot {
  count: number;
  reminded: boolean;
}

type PendingCall = { relevant: boolean };

const LIMIT = 10;
const MAX_PENDING = 64;
const OPERATIONS = new Set(["search", "get", "replay"]);
const SCOPES = new Set(["repository", "worktree"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function valueAt(event: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (event[name] !== undefined) return event[name];
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requestData(event: unknown): Record<string, unknown> | undefined {
  const e = object(event);
  if (!e) return undefined;
  // Tool adapters have used each of these names for the JSON request.
  for (const key of ["arguments", "input", "params", "data", "request", "args"]) {
    const nested = object(e[key]);
    if (nested) return nested;
    if (typeof e[key] === "string") {
      try { const parsed = JSON.parse(e[key] as string); if (object(parsed)) return parsed as Record<string, unknown>; } catch { /* not JSON */ }
    }
  }
  return e;
}

function isRelevant(event: unknown): boolean {
  const outer = object(event);
  if (outer?.toolName !== "memory_history" && outer?.name !== "memory_history") return false;
  const data = requestData(event);
  if (!data) return false;
  const operation = stringValue(valueAt(data, ["operation", "op"]));
  const scope = stringValue(data.scope) ?? "repository";
  return !!operation && OPERATIONS.has(operation) && SCOPES.has(scope);
}

function hasError(event: unknown): boolean {
  const e = object(event);
  if (!e) return true;
  if (e.isError === true || e.error !== undefined) return true;
  if (e.result !== undefined && hasError(e.result)) return true;
  const content = e.content;
  const candidates = Array.isArray(content) ? content : [content];
  for (const item of candidates) {
    const part = object(item);
    if (part && part.error !== undefined) return true;
    const raw = part ? valueAt(part, ["text", "content"]) : item;
    if (object(raw)?.error !== undefined) return true;
    if (typeof raw !== "string") continue;
    try { if (object(JSON.parse(raw))?.error !== undefined) return true; } catch { /* ordinary result */ }
  }
  return false;
}

export function createMemoryQueryBudget() {
  let count = 0;
  let reminded = false;
  let reminder: string | undefined;
  const pending = new Map<string, PendingCall>();

  const reminderText = () =>
    "Soft reminder: please make a task-relevant memory_history query (search/get/replay) when useful; a valid no-match result is fine. Do not invent memory or abandon the task.";

  return {
    turnEnd() {
      count += 1;
      if (count >= LIMIT && !reminded) { reminded = true; reminder = reminderText(); }
    },
    toolCall(event: unknown) {
      const e = object(event);
      const id = stringValue(e && valueAt(e, ["toolCallId", "id"]));
      if (!id) return;
      if (pending.has(id)) pending.delete(id);
      if (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (typeof oldest === "string") pending.delete(oldest);
      }
      pending.set(id, { relevant: isRelevant(event) });
    },
    toolResult(event: unknown) {
      const e = object(event);
      const id = stringValue(e && valueAt(e, ["toolCallId", "id"]));
      if (!id) return;
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      if (call.relevant && !hasError(event)) { count = 0; reminded = false; reminder = undefined; }
    },
    newGoal() { count = 0; reminded = false; reminder = undefined; pending.clear(); },
    restore(data: unknown) {
      const d = object(data);
      if (!d || !Number.isSafeInteger(d.count) || (d.count as number) < 0 || (d.count as number) > Number.MAX_SAFE_INTEGER || typeof d.reminded !== "boolean") return;
      count = d.count as number;
      reminded = d.reminded as boolean;
      reminder = undefined;
      pending.clear();
    },
    snapshot(): MemoryQueryBudgetSnapshot { return { count, reminded }; },
    takeReminder() { const result = reminder; reminder = undefined; return result; },
  };
}
