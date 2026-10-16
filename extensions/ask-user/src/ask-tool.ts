import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { appendAskPayload } from "./ask-payload-store.ts";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_PROMPT_GUIDELINES,
	invalidPayloadResponse,
	nonInteractiveResponse,
	renderAskToolCall,
	renderAskToolResult,
	successfulResponse,
	validateParams,
} from "./ask-tool-helpers.ts";
import { getAskConfigStore } from "./config/store.ts";
import {
	applyRemoteAskResponse,
	type RemoteAskFlowHandle,
	type RemoteAskRuntime,
} from "./remote-ask.ts";
import { AskParamsSchema } from "./schema.ts";
import { prepareAskParams } from "./state/normalize.ts";
import { toAskResult } from "./state/result.ts";
import type { AskParams, AskResult, AskState } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";

// A headless remote answer that never arrives fails closed as cancelled after this long.
export const REMOTE_ASK_TIMEOUT_MS = 30 * 60 * 1000;

export function registerAskTool(
	pi: ExtensionAPI,
	remoteAsk?: RemoteAskRuntime
) {
	pi.registerTool({
		name: "ask_user_question",
		executionMode: "sequential",
		label: "Ask User",
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet:
			"Clarify ambiguous or preference-sensitive decisions with a short interactive interview before proceeding",
		promptGuidelines: [...ASK_TOOL_PROMPT_GUIDELINES],
		parameters: AskParamsSchema,
		prepareArguments: (args) => prepareAskParams(args) as AskParams,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			executeAskTool(
				pi,
				toolCallId,
				params as AskParams,
				signal,
				onUpdate,
				ctx,
				remoteAsk
			),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

async function executeAskTool(
	pi: Pick<ExtensionAPI, "appendEntry">,
	toolCallId: string,
	params: AskParams,
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
	remoteAsk?: RemoteAskRuntime
) {
	const config = await getAskConfigStore().getConfig();
	const validation = validateParams(params, {
		presentSingleAsMulti: config.behaviour.presentSingleAsMulti,
	});
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	appendAskPayload(pi, {
		params,
		source: "tool",
		sourceEntryId: toolCallId,
	});
	if (ctx.mode !== "tui") {
		return nonInteractiveResponse(validation.state);
	}
	// A TUI without bound UI (headless Tern) answers only through the remote-ask events.
	if (!ctx.hasUI) {
		if (!remoteAsk) {
			return nonInteractiveResponse(validation.state);
		}
		const result = await runRemoteAskFlow(
			remoteAsk,
			validation.state,
			toolCallId,
			signal
		);
		return successfulResponse(result);
	}
	ctx.ui.setWorkingVisible(false);
	try {
		const result = await runAskFlow(ctx, params, {
			remote: remoteAsk
				? { runtime: remoteAsk, source: "tool", toolCallId }
				: undefined,
		});
		return successfulResponse(result);
	} finally {
		ctx.ui.setWorkingVisible(true);
	}
}

// Resolves only from an accepted explicit response (answer or cancel), abort, or timeout.
// Nothing here answers or approves on the user's behalf.
export function runRemoteAskFlow(
	runtime: RemoteAskRuntime,
	initial: AskState,
	toolCallId: string,
	signal: AbortSignal | undefined,
	timeoutMs: number = REMOTE_ASK_TIMEOUT_MS
): Promise<AskResult> {
	return new Promise((resolve) => {
		let state = initial;
		let handle: RemoteAskFlowHandle | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const cancelledResult = (): AskResult =>
			toAskResult(applyRemoteAskResponse(state, { kind: "cancel" }).state);
		const finish = (result: AskResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			handle?.complete(result);
			resolve(result);
		};
		const onAbort = (): void => finish(cancelledResult());

		if (signal?.aborted) {
			resolve(cancelledResult());
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		handle = runtime.startFlow({
			source: "tool",
			toolCallId,
			title: initial.title,
			questions: initial.questions,
			onSubmit(response) {
				const resolution = applyRemoteAskResponse(state, response);
				if (!resolution.ok) {
					return resolution;
				}
				state = resolution.state;
				if (state.completed) {
					finish(toAskResult(state));
				}
				return { ok: true };
			},
		});
		timer = setTimeout(() => finish(cancelledResult()), timeoutMs);
	});
}
