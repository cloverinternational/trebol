/** Model-facing contracts for the Hoja read tools registered by extensions/hoja-mode. */
import type { ToolContract } from "../runtime/tool-contract.ts";

export const HOJA_LIST_CONTRACT: ToolContract = {
	description: "List up to 100 open Hoja work items (identifier, title, state, priority, assignee, project). Returns issues, returnedCount and truncated. If truncated, returnedCount is NOT the total board size. Read-only; this tool cannot change Hoja.",
	parameters: { type: "object", additionalProperties: false, properties: {} },
};

export const HOJA_GET_CONTRACT: ToolContract = {
	description: "Get one Hoja issue by identifier, for example TREBOL-237. Searches the 250 most recent issues. Read-only; this tool cannot change Hoja.",
	parameters: {
		type: "object",
		required: ["identifier"],
		additionalProperties: false,
		properties: { identifier: { type: "string", description: "Hoja issue identifier, for example TREBOL-237." } },
	},
};

export const CONTRACTS: Record<string, ToolContract> = {
	hoja_list: HOJA_LIST_CONTRACT,
	hoja_get: HOJA_GET_CONTRACT,
};
