// Messages queued while Pi works, drawn in the dock between the running-work card and the composer.
// A port of OMP's QueuedMessagesBand native branch (@oh-my-pi/pi-tui src/prompt/queued-messages.ts):
// col `omp.queue` > one row `omp.queue.item` per message (icon · single-line text · Edit), the total
// count as a badge on the first pill when more than one waits. Tern's built-in CSS styles these roles.
import type { TspNode } from "./tsp.ts";

export interface QueuedGroup {
	label: string;
	messages: readonly string[];
}

// OMP's group headings: steering lands mid-turn, follow-ups after the agent yields.
export function queueGroups(steering: readonly string[], followUp: readonly string[]): QueuedGroup[] {
	return [
		{ label: "Steering", messages: steering },
		{ label: "After yield", messages: followUp },
	].filter((group) => group.messages.length > 0);
}

export function queueNodes(groups: readonly QueuedGroup[], dequeueKeys: readonly string[] = ["alt", "up"]): TspNode[] {
	const count = groups.reduce((sum, group) => sum + group.messages.length, 0);
	if (count === 0) return [];
	const pills: TspNode[] = [];
	for (const group of groups) {
		group.messages.forEach((message, index) => {
			const id = `queue-${group.label === "Steering" ? "steer" : "follow"}-${index}`;
			const children: TspNode[] = [
				{ id: `${id}-icon`, k: "icon", p: { name: "corner-down-right" } },
				{ id: `${id}-text`, k: "text", p: { text: message.replace(/\t/g, "   ").replace(/\s*\r?\n\s*/g, " ↵ "), wrap: "none", truncate: "end", grow: 1 } },
			];
			if (pills.length === 0 && count > 1) children.push({ id: `${id}-count`, k: "badge", p: { text: `${count}`, role: "omp.queue.count" } });
			children.push({
				id: `${id}-edit`,
				k: "row",
				p: { role: "omp.queue.edit", gap: "xs", align: "center", title: "Edit  ⌥↑", actions: { click: "queue.edit" } },
				c: [
					{ id: `${id}-edit-key`, k: "kbd", p: { keys: [...dequeueKeys] } },
					{ id: `${id}-edit-label`, k: "text", p: { text: "Edit" } },
				],
			});
			pills.push({ id, k: "row", p: { role: "omp.queue.item", align: "center", gap: "sm", title: group.label }, c: children });
		});
	}
	return [{ id: "queue", k: "col", p: { role: "omp.queue", gap: "xs" }, c: pills }];
}
