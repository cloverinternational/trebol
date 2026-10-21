import { modeFooter } from "../../.pi/lib/runtime/mode-footer.ts";
/** Hoja mode: read-only Hoja tools plus a rule that makes the agent check Hoja before advising on work. */
import { HojaClient, HojaRequestError } from "../../.pi/lib/claw/hoja.ts";
import { latestSessionModeEntry } from "../../.pi/lib/runtime/session-mode-entry.ts";

export const HOJA_RULE = "Hoja mode: for any question about work, status, priority, or what to do next, call hoja_list (or hoja_get for one identifier) before answering. Hoja tools are read-only. Never say a Hoja change was made. If a Hoja change is needed, state the exact change and ask the user to confirm it in this conversation; do not attempt it.";
export const HOJA_ENTRY = "hoja-mode";

const OPEN_ISSUES = `query ($first: Int!) { issues(first: $first, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title priority state { name } assignee { name } project { name } } } }`;
const ALL_ISSUES = `query ($first: Int!) { issues(first: $first) { nodes { identifier title priority state { name } assignee { name } project { name } } } }`;

type Issue = { identifier: string; title: string; priority: number; state: { name: string } | null; assignee: { name: string } | null; project: { name: string } | null };
type Gql = Pick<HojaClient, "gql">;

const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {}, ...(isError ? { isError: true } : {}) });

export function hojaTools(client: Gql) {
	const load = async (query: string, first: number) => (await client.gql<{ issues: { nodes: Issue[] } }>(query, { first })).issues.nodes;
	const error = (e: unknown) => text({ error: e instanceof HojaRequestError ? e.message : "Hoja lookup failed; no raw error details exposed." }, true);
	return [
		{
			name: "hoja_list",
			label: "Hoja list",
			description: "List open Hoja issues (identifier, title, state, priority, assignee, project). Read-only.",
			parameters: { type: "object", additionalProperties: false, properties: {} },
			async execute() {
				try {
					// One sentinel record detects partial lists without depending on pageInfo support.
					const nodes = await load(OPEN_ISSUES, 101);
					return text({ issues: nodes.slice(0, 100), returnedCount: Math.min(nodes.length, 100), truncated: nodes.length > 100,
						note: nodes.length > 100 ? "Partial board: more than 100 open issues. Do not report returnedCount as the total." : "Complete open-issue list." });
				} catch (e) { return error(e); }
			},
		},
		{
			name: "hoja_get",
			label: "Hoja get",
			description: "Get one Hoja issue by identifier (for example TREBOL-237). Scans up to 250 recent issues. Read-only.",
			parameters: { type: "object", required: ["identifier"], additionalProperties: false, properties: { identifier: { type: "string" } } },
			async execute(_id: string, params: { identifier: string }) {
				try {
					const issue = (await load(ALL_ISSUES, 250)).find(i => i.identifier === params.identifier);
					return issue ? text(issue) : text({ error: `issue ${params.identifier} not found in the 250 most recent issues` }, true);
				} catch (e) { return error(e); }
			},
		},
	];
}

export function registerHojaMode(pi: any, client: Gql = new HojaClient()) {
	let enabled = true;
	const footer = modeFooter("hoja", () => enabled);
	const setEnabled = (next: boolean) => { enabled = next; pi.appendEntry?.(HOJA_ENTRY, { enabled }); };
	for (const tool of hojaTools(client)) pi.registerTool(tool);
	pi.registerCommand("hoja", {
		description: "Hoja work mode: /hoja on|off|status (read-only; session-local)",
		handler: async (args: string, ctx: any) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") setEnabled(true);
			else if (action === "off") setEnabled(false);
			else if (action !== "status") {
				ctx.ui?.notify?.("Usage: /hoja on|off|status", "warning");
				return;
			}
			footer.refresh(ctx);
			ctx.ui?.notify?.(`Hoja mode ${enabled ? "on" : "off"}. ${enabled ? "Work questions check Hoja first." : "Automatic Hoja-first guidance disabled; read tools remain available."} Read-only. Saved per chat; kept across /reload, resume and fork.`, "info");
		},
	});
	// A new chat has no saved entry and starts on; a reloaded or resumed chat restores its own saved choice.
	pi.on("session_start", (_event: unknown, ctx: any) => { enabled = latestSessionModeEntry<{ enabled?: boolean }>(ctx, HOJA_ENTRY)?.enabled !== false; footer.refresh(ctx); });
	pi.on("session_shutdown", (_event: unknown, ctx: any) => footer.clear(ctx));
	pi.on("before_agent_start", (event: any) => enabled
		? { systemPrompt: String(event.systemPrompt ?? "") + "\n" + HOJA_RULE }
		: undefined);
}

export default function hojaMode(pi: any) {
	registerHojaMode(pi);
}
