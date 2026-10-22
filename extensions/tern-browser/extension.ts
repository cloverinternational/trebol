import { withDefaultToolRenderer } from "../../packages/runtime/core/src/tool-renderer.ts";
import { TERN_TOOL, realDeps, runTern } from "../../.pi/lib/tern/browser.ts";

const error = (e: unknown) => ({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true, details: {} });

export default function ternExtension(pi: any) {
	pi.registerTool(withDefaultToolRenderer({
		...TERN_TOOL,
		async execute(_id: string, p: any, signal: AbortSignal | undefined) {
			try {
				const result = await runTern(p, realDeps(process.env, signal));
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			} catch (e) {
				return error(e);
			}
		},
	}));
}
