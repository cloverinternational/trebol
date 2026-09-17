export type ConsultationFailure = "model-failure" | "cancelled" | "malformed-json";
export type ConsultationResult = { status: "completed"; value: unknown } | { status: ConsultationFailure; error: string };

// Pi exec buffers output internally; this bounds accepted output, not peak memory.
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 30_000;

function modelName(model: any): string | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return model.includes("/") ? model : undefined;
  const provider = model.provider ?? model.providerID;
  const id = model.id ?? model.modelId ?? model.modelID;
  return provider && id ? `${provider}/${id}` : undefined;
}

/** Run a timeout-limited, tool-less Pi consultation. The child receives only the
 * supplied outline; the parent remains responsible for materializing reads. */
export async function consultWithPi(pi: any, input: {
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  model?: any;
  generation?: number;
  currentGeneration?: () => number;
}): Promise<ConsultationResult> {
  if (input.signal?.aborted) return { status: "cancelled", error: "consultation cancelled before spawn" };
  if (input.generation !== undefined && input.currentGeneration && input.currentGeneration() !== input.generation) return { status: "cancelled", error: "stale session generation" };
  if (typeof pi?.exec !== "function") return { status: "model-failure", error: "Pi exec is unavailable" };
  const model = modelName(input.model);
  if (!model) return { status: "model-failure", error: "no verified session model" };
  const args = ["-p", "--model", model, "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-tools", "--no-prompt-templates", "--mode", "text", "--thinking", "off", "--", input.prompt];
  try {
    const result = await pi.exec("pi", args, { cwd: input.cwd, signal: input.signal, timeout: TIMEOUT_MS });
    if (input.signal?.aborted) return { status: "cancelled", error: "consultation cancelled" };
    if (input.generation !== undefined && input.currentGeneration && input.currentGeneration() !== input.generation) return { status: "cancelled", error: "stale session generation" };
    if (Buffer.byteLength(String(result?.stdout ?? "")) > MAX_OUTPUT) return { status: "model-failure", error: "consultation output exceeded limit" };
    if (result?.killed || result?.code !== 0) return { status: "model-failure", error: `consultation process failed (${result?.killed ? "timeout or killed" : result?.code})` };
    try {
      return { status: "completed", value: JSON.parse(String(result?.stdout ?? "").trim()) };
    } catch {
      return { status: "malformed-json", error: "consultation returned malformed JSON" };
    }
  } catch (error) {
    if (input.signal?.aborted) return { status: "cancelled", error: "consultation cancelled" };
    return { status: "model-failure", error: "consultation process unavailable" };
  } finally {
    // pi.exec owns process cancellation through the supplied signal.
  }
}
