import { describe, expect, it } from "vitest";
import { TranscriptProjector } from "../../lib/tern/bridge.ts";
import { projectTranscript, type TspNode } from "../../lib/tern/tsp.ts";

const partial = "```mermaid\nflowchart LR\nA-->B\n";
const complete = `${partial}\`\`\``;
const markdown = (nodes: TspNode[]): TspNode[] => nodes.flatMap((n) => [
	...(n.k === "md" ? [n] : []), ...markdown(n.c ?? []),
]);
const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("Markdown lifecycle", () => {
	it("defaults finalized projection to non-streaming and leaves the source unchanged", () => {
		const body = markdown(projectTranscript([{ id: "a", role: "assistant", text: complete }]))[0];
		expect(body.p).toEqual({ text: complete, stream: false });
	});

	it("marks expanded work narration provisional until message_end", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "agent_start" });
		p.apply({ type: "message_start", message: message(partial) });
		expect(markdown(p.nodes(true))[0].p).toMatchObject({ text: partial, stream: true });
		// The live card opens by default (activity panel); revealing it does not alter the streamed source state.
		expect(p.nodes(false).filter((n) => n.p?.role === "tern.work-live").map((n) => [n.p?.role, n.p?.collapsed])).toEqual([["tern.work-live", false]]);
		p.apply({ type: "message_end", message: message(complete) });
		expect(markdown(p.nodes(true))[0].p).toMatchObject({ text: complete, stream: false });
		p.apply({ type: "agent_end" });
		expect(markdown(p.nodes(false))[0].p).toMatchObject({ text: complete, stream: false });
	});

	it("settles partial text on abort without fabricating a closing fence", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "agent_start" });
		p.apply({ type: "message_start", message: message(partial) });
		p.apply({ type: "agent_end" });
		expect(markdown(p.nodes(true))[0].p).toMatchObject({ text: partial, stream: false });
	});

	it("restores final answers and folded tool narration as non-streaming", () => {
		const p = new TranscriptProjector();
		p.replaceFromSessionBranch([
			{ id: "a", type: "message", message: { ...message(complete), content: [...message(complete).content, { type: "toolCall", id: "t", name: "read", arguments: {} }] } },
			{ id: "r", type: "message", message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "ok" }] } },
			{ id: "b", type: "message", message: message(complete) },
		]);
		for (const expanded of [false, true, false]) {
			const bodies = markdown(p.nodes(expanded));
			expect(bodies).toHaveLength(2);
			for (const body of bodies) expect(body.p).toMatchObject({ text: complete, stream: false });
		}
	});
});
