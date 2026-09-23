/** One tool's model-facing contract: the description and JSON Schema the model sees. */
export interface ToolContract { description: string; parameters: Record<string, unknown> }
