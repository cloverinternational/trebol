/** Conservative intent gate: diagrams are useful for a requested explanation, not every code-edit report. */
export function wantsMermaidExplanation(prompt: string): boolean {
  if (/\b(?:mermaid|diagram|flowchart|visuali[sz]e|draw (?:a |the )?flow)\b/i.test(prompt)) return true;
  // An explicit request to probe the post-response diagram hook is itself
  // diagram intent, even when the user intentionally avoids saying "diagram".
  if (/\b(?:reloaded?|post.response|hook)\b/i.test(prompt)
    && /\b(?:ignor\w*|omit\w*|skip\w*|miss\w*|catch\w*|detect\w*|test\w*)\b/i.test(prompt)
    && /\b(?:catch\w*|detect\w*|hook|reloaded?)\b/i.test(prompt)) return true;
  return /\b(?:explain|understand|how (?:does|do|can|would)|walk(?:through| me through))\b/i.test(prompt)
    && /\b(?:tool|hook|skill|budget|agent|harness|policy|workflow|architecture|process|footer|status|interface|rendering|display)\b/i.test(prompt);
}

/** A complete Mermaid fence, not a bare mention or an unclosed draft. */
export const hasMermaidDiagram = (text: string): boolean => /^(`{3,}|~{3,})mermaid\s*\n[\s\S]*?^\1\s*$/m.test(text);

/** The follow-up must keep the model on the user's original request. Naming
 * this hook's own source files is only appropriate when the user asked about
 * the hook: otherwise the model obeys the file list and replaces its answer
 * with a walkthrough of the Mermaid hook (traced in #299). */
const ABOUT_THIS_HOOK = /\b(?:mermaid|post.response|diagram (?:hook|follow.?up))\b/i;
export function mermaidFollowup(prompt: string): string {
  return [
    "The previous explanation omitted a Mermaid diagram requested or useful for this conceptual question.",
    "Stay on the user's original request: add a diagram of the behavior you already explained, keeping your answer's conclusions and any requested report format. Do not switch topics.",
    ...(ABOUT_THIS_HOOK.test(prompt) ? ["The question concerns this repository's Mermaid response hook: if you have not inspected its implementation, use available read tools to inspect extensions/mermaid-response/extension.ts, .pi/lib/context/mermaid-response.ts and .pi/lib/context/mermaid-followup.ts before explaining it."] : []),
    "Provide a concise final walkthrough with one or more relevant fenced ```mermaid diagrams and prose explaining their transitions. Do not draw a speculative diagram of unknown implementation merely to satisfy the diagram request. If source access is unavailable, state that limit rather than inventing behavior. Do not claim the previous reply was replaced.",
  ].join(" ");
}
/** Follow-up for a prompt about the hook itself (kept for existing callers). */
export const MERMAID_FOLLOWUP = mermaidFollowup("mermaid");
