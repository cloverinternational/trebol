// The /btw cross-frontend contract, kept free of Pi imports so a native frontend (Tern) and its tests can
// import it. Pi's tui renders the view in-process; anything else draws BtwState snapshots and answers on
// the bus, which is the same split ask-user uses for ask_user_question.
export const BTW_STATE_EVENT = "@pi-swarm/btw:state";
export const BTW_SUBMIT_EVENT = "@pi-swarm/btw:submit";
export const BTW_ABORT_EVENT = "@pi-swarm/btw:abort";
export const BTW_CLOSE_EVENT = "@pi-swarm/btw:close";

export type BtwEntry = { question: string; answer: string; error?: string };

export interface BtwState {
	open: boolean;
	active?: { question: string; answer: string };
	entries: BtwEntry[];
}
