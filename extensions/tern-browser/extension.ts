import { withDefaultToolRenderer } from "../../packages/runtime/core/src/tool-renderer.ts";
import { createOwnership, realDeps, runTern, ternToolFor } from "../../.pi/lib/tern/browser.ts";
import { detectBackendSync } from "../../.pi/lib/panes/install-probe.ts";
import { opsFor, runPaneOp } from "../../.pi/lib/panes/dispatch.ts";
import { createHerdrBackend } from "../../.pi/lib/panes/herdr.ts";

const error = (e: unknown) => ({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true, details: {} });

export default function ternExtension(pi: any) {
	// Which runtime answers is decided once, at load: the schema has to be built synchronously.
	// With neither runtime installed nothing is registered — the session-start prompt explains
	// what to install, which is far better than a tool that fails every call with ENOENT.
	const detected = detectBackendSync();
	if (detected.backend === "none") return;
	// Ownership outlives a single call: send/close act only on what this process created.
	const owned = createOwnership();
	const herdr = detected.backend === "herdr" ? createHerdrBackend() : undefined;
	const ops = opsFor(detected.capabilities.browser);
	pi.registerTool(withDefaultToolRenderer({
		...ternToolFor(ops),
		async execute(_id: string, p: any, signal: AbortSignal | undefined) {
			try {
				const result = herdr
					? await runPaneOp(p, herdr, owned)
					: await runTern(p, realDeps(process.env, signal));
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			} catch (e) {
				return error(e);
			}
		},
	}));
}
