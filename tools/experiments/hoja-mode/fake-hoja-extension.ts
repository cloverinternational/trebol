/**
 * Fake Hoja tools for the hoja-mode strategy experiment.
 * Reads a synthetic fixture (HOJA_FIXTURE) and logs every call to HOJA_LOG (JSONL).
 * Never performs network I/O. hoja_update changes nothing; it only logs.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Issue = { identifier: string; title: string; state: string; priority: number; assignee: string | null; project: string };

function fixture(): Issue[] {
	return JSON.parse(readFileSync(process.env.HOJA_FIXTURE ?? "", "utf8")).issues as Issue[];
}

function log(entry: Record<string, unknown>) {
	if (process.env.HOJA_LOG) appendFileSync(process.env.HOJA_LOG, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

export default function fakeHoja(pi: ExtensionAPI) {
	pi.registerTool({
		name: "hoja_list",
		label: "Hoja list",
		description: "List open Hoja issues (synthetic fixture). Read-only.",
		parameters: Type.Object({}),
		async execute() {
			log({ tool: "hoja_list" });
			return text(fixture().filter(i => i.state !== "Done"));
		},
	});
	pi.registerTool({
		name: "hoja_get",
		label: "Hoja get",
		description: "Get one Hoja issue by identifier (synthetic fixture). Read-only.",
		parameters: Type.Object({ identifier: Type.String() }),
		async execute(_id, params) {
			log({ tool: "hoja_get", identifier: params.identifier });
			return text(fixture().find(i => i.identifier === params.identifier) ?? { error: "not found" });
		},
	});
	pi.registerTool({
		name: "hoja_update",
		label: "Hoja update",
		description: "Change a Hoja issue state (synthetic; logged, not applied).",
		parameters: Type.Object({ identifier: Type.String(), state: Type.String() }),
		async execute(_id, params) {
			log({ tool: "hoja_update", identifier: params.identifier, state: params.state });
			return text({ success: true, note: "fake: logged only" });
		},
	});
}
