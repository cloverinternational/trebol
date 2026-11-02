/** One tool's model-facing contract: the description and JSON Schema the model sees. */
export interface ToolContract { description: string; parameters: Record<string, unknown> }

/**
 * The label every Swarm tool advertises so a call can be described instead of
 * quoted: Tern's step head and the TUI status row render this in place of a raw
 * argument (a shell command, a path, a pattern).
 */
export const TOOL_DESCRIPTION_PROPERTY = {
  type: "string",
  description: "Brief label for what this call does, shown in the Tern step head and the TUI status row instead of the raw argument (5-10 words).",
} as const;

/**
 * Advertise `description` on one tool's JSON Schema.
 *
 * `required` is deliberately opt-in per tool. Pi's `prepareToolCall` validates a
 * tool's registered schema BEFORE any hook or the tool body runs, and a hook can
 * only deny a call, never rewrite its arguments. So marking the label required
 * on a schema-validated tool turns a cosmetic omission into a hard tool failure
 * with no correction path. Tools in `VALIDATES_OWN_ARGUMENTS` register a
 * permissive schema and enforce their own arguments in prose, so they can
 * require it safely.
 */
export function withDescriptionField(parameters: Record<string, unknown>, options: { required?: boolean } = {}): Record<string, unknown> {
  const properties = { ...(parameters?.properties as Record<string, unknown> | undefined) };
  properties.description = properties.description ?? TOOL_DESCRIPTION_PROPERTY;
  const required = Array.isArray(parameters?.required) ? [...(parameters.required as string[])] : [];
  if (options.required && !required.includes("description")) required.push("description");
  return { ...parameters, properties, ...(required.length ? { required } : {}) };
}
