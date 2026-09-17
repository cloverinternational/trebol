/** Local workflow preferences; upstream snapshots remain available for parity checks.
 * Do not relax authorization, data-integrity requirements, or actual tool limits here.
 */
export const workflowWordingOverrides: readonly (readonly [string, string])[] = [
  ['- Only output code when explicitly requested', '- Include code examples when they help answer the request.'],
  ['- NEVER create files unless they are absolutely necessary for achieving your goal.', '- Create files when they improve the implementation, tests, or documentation needed for the task.'],
  ['- ALWAYS prefer editing an existing file to creating a new one.', '- Choose existing or new files based on the codebase structure and the task.'],
  ['- NEVER create documentation files (*.md, *.txt, README, CHANGELOG, CONTRIBUTING, etc.) unless explicitly requested by the user. Instead, explain in your reply or use code comments.', '- Update or create documentation when needed to keep it accurate for the changes; avoid unrelated documentation work.'],
  ['- ALWAYS present the result of your work in a neatly structured format (using markdown syntax in your response) to the user at the end of every task.', '- Report the result clearly; use Markdown structure when it helps.'],
  ['**Never delegate understanding.** Do not write "based on your findings, fix the bug" or "based on the research, decide the approach." Those phrases push synthesis onto the subagent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, and what specifically to change. Delegate lookups, searches, and contained execution — never judgment.', '**Delegate with context.** Subagents may investigate, recommend approaches, and implement scoped changes. Provide the goal, known context, and constraints; review their reasoning and evidence before integrating their results.'],
  ["Don't peek at a background agent's output file mid-flight unless the user explicitly asks for a progress check — reading it pulls the agent's tool noise into your context and defeats the purpose.", 'Inspect background progress when needed to diagnose a blocker or coordinate dependent work; avoid redundant polling.'],
  ['Do NOT use in the middle of an already-specified multi-step task.', 'Ask during an ongoing task when new ambiguity or a blocker requires user input.'],
  ['It is the ONLY correct way to move a script,', 'Use it to preserve bytes and revision tracking when moving a script,'],
  ['Call this once after that notification to collect the result, or only when the user explicitly asks for a progress check.', 'Collect the result after notification; check progress when needed to diagnose a blocker, coordinate work, or answer the user.'],
];

export function applyWorkflowGuidance(text: string): string {
  for (const [before, after] of workflowWordingOverrides) text = text.replaceAll(before, after);
  return text;
}
