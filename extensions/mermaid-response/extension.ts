import { repairMermaidResponse } from "../../.pi/lib/context/mermaid-response.ts";
import { hasMermaidDiagram, mermaidFollowup, wantsMermaidExplanation } from "../../.pi/lib/context/mermaid-followup.ts";

/** message_end is the Pi replacement boundary before final display and persistence. */
export default function mermaidResponseExtension(pi: any): void {
  let eligible = false;
  let requested = false;
  let lastPrompt = "";
  // A subagent's final text is its machine-read deliverable; a diagram
  // follow-up turn would replace it (#299).
  const isSubagent = process.env.PI_SWARM_SUBAGENT === "1";
  pi.on("input", (event: any) => {
    if (event?.source !== "interactive" && event?.source !== "rpc") return;
    const prompt = String(event.text ?? "").trim();
    // A bare continuation belongs to the previous external request. Do not
    // rearm an already-spent follow-up or forget eligible diagram-test intent.
    if (/^(?:continue|go on|keep going)[.!]?$/i.test(prompt)) return;
    eligible = !isSubagent && wantsMermaidExplanation(prompt);
    lastPrompt = prompt;
    requested = false;
  });
  pi.on("session_start", () => { eligible = false; requested = false; });
  pi.on("session_switch", () => { eligible = false; requested = false; });
  pi.on("message_end", async (event: any) => {
    const message = event?.message;
    if (message?.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content) || message.content.some((part: any) => part?.type === "toolCall")) return;
    let changed = false;
    const content = await Promise.all(message.content.map(async (part: any) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const text = await repairMermaidResponse(part.text);
      if (text !== part.text) changed = true;
      return text === part.text ? part : { ...part, text };
    }));
    return changed ? { message: { ...message, content } } : undefined;
  });
  pi.on("turn_end", (event: any, ctx: any) => {
    const message = event?.message;
    if (!eligible || requested || message?.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content) || message.content.some((part: any) => part?.type === "toolCall") || ctx?.signal?.aborted || ctx?.hasPendingMessages?.()) return;
    const text = message.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
    if (text.trim().length < 80 || hasMermaidDiagram(text)) return;
    requested = true; // Set before dispatch; a failed delivery must not loop.
    pi.sendMessage({ customType: "pi-swarm-mermaid-followup", content: mermaidFollowup(lastPrompt), display: false }, { deliverAs: "followUp", triggerTurn: true });
  });
}
