/** Model-facing contracts for the Hoja read tools registered by extensions/hoja-mode. */
import type { ToolContract } from "../runtime/tool-contract.ts";
import { OPERATION_CONTRACTS } from "./hoja-operations.ts";

export const HOJA_LIST_CONTRACT: ToolContract = {
	description: "List Hoja work items with server-side filters, returning identifier, title, state, priority, assignee, project, createdAt and updatedAt for each. Defaults to open issues; state \"closed\" lists Done and Canceled items (for example what finished yesterday) and state \"open\"/\"all\" widen it. Also filters by assignee, project, team, and by updatedSince/updatedBefore/createdSince/createdBefore (ISO date, a bare YYYY-MM-DD meaning UTC midnight). Returns issues, returnedCount, truncated and the appliedFilter. When truncated is true, returnedCount is NOT the total board size: narrow the filters or raise limit. Read-only; this tool cannot change Hoja.",
	parameters: {
		type: "object",
		additionalProperties: false,
		properties: {
			state: { type: "string", description: "\"open\" (default: not Done or Canceled), \"closed\" (Done and Canceled), \"all\", a workflow state type (backlog, unstarted, started, completed, canceled) or an exact state name such as \"In Review\"." },
			assignee: { type: "string", description: "Assignee name, case-insensitive substring (for example \"Luis\")." },
			project: { type: "string", description: "Project name, case-insensitive exact match." },
			team: { type: "string", description: "Team key, for example TREBOL." },
			updatedSince: { type: "string", description: "Only issues updated at or after this instant. ISO date (YYYY-MM-DD = UTC midnight) or ISO timestamp." },
			updatedBefore: { type: "string", description: "Only issues updated before this instant. Pair with updatedSince to isolate one day." },
			createdSince: { type: "string", description: "Only issues created at or after this instant." },
			createdBefore: { type: "string", description: "Only issues created before this instant." },
			limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum issues to return (default 100, max 200). One extra row is read to report truncation honestly." },
		},
	},
};

export const HOJA_GET_CONTRACT: ToolContract = {
	description: "Get one Hoja issue by identifier, for example TREBOL-237, looked up server-side so any issue is reachable no matter how old it is. Returns title, description, priority, createdAt, updatedAt, url, state (name and type), team, assignee, project and the most recent comments with author, date and body (long bodies truncated). Read-only; this tool cannot change Hoja.",
	parameters: {
		type: "object",
		required: ["identifier"],
		additionalProperties: false,
		properties: {
			identifier: { type: "string", description: "Hoja issue identifier, for example TREBOL-237." },
			comments: { type: "integer", minimum: 1, maximum: 50, description: "How many recent comments to return (default 10, max 50)." },
		},
	},
};

export const CONTRACTS: Record<string, ToolContract> = {
	...OPERATION_CONTRACTS,
	hoja_list: HOJA_LIST_CONTRACT,
	hoja_get: HOJA_GET_CONTRACT,
};
