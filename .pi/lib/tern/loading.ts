// Loading indicator state for the Tern dock. Pure: no timers, no I/O. The bridge feeds it Pi events and
// renders whatever loadingNode() returns. Every terminal signal (end, settle, abort, failure, session switch,
// close) returns to idle, so the indicator cannot outlive the turn it describes.

import type { TspNode } from "./tsp.ts";

export const LOADING_NODE_ID = "tern.loading";

export type LoadingPhase = "idle" | "pending" | "running";

export interface LoadingState {
	readonly phase: LoadingPhase;
	readonly sessionId: string | null;
	readonly closed: boolean;
}

export type LoadingEvent =
	| { type: "prompt_start" }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "agent_settled" }
	| { type: "abort" }
	| { type: "failure" }
	| { type: "session_switch"; sessionId: string | null }
	| { type: "close" };

export const IDLE_LOADING: LoadingState = { phase: "idle", sessionId: null, closed: false };

export function reduceLoading(state: LoadingState, event: LoadingEvent): LoadingState {
	if (state.closed) return state;
	switch (event.type) {
		case "prompt_start":
			return state.phase === "running" ? state : { ...state, phase: "pending" };
		case "agent_start":
			return { ...state, phase: "running" };
		case "agent_end":
		case "agent_settled":
		case "abort":
		case "failure":
			return state.phase === "idle" ? state : { ...state, phase: "idle" };
		case "session_switch":
			return { ...IDLE_LOADING, sessionId: event.sessionId };
		case "close":
			return { phase: "idle", sessionId: state.sessionId, closed: true };
	}
}

/** Dock node for the current phase, or null when nothing is loading. The id is stable across phases. */
export function loadingNode(state: LoadingState): TspNode | null {
	if (state.phase === "idle") return null;
	if (state.phase === "pending") {
		return { id: LOADING_NODE_ID, k: "spinner", p: { label: "Waiting for agent", style: "dots" } };
	}
	return { id: LOADING_NODE_ID, k: "shimmer", p: { text: "Working" } };
}
