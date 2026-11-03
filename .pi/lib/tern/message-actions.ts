// Edit and Resend for your own messages in the transcript. Both go through Pi's own branch primitive,
// AgentSession.navigateTree: on a user entry it moves the leaf to that entry's parent, so the original prompt and
// everything after it stay in the session as a branch (visible in /tree) and the new prompt starts a sibling. Nothing
// is deleted or rewritten. Edit changes nothing in the session until you send: the composer holds the text (and the
// message's images) and Esc puts back what you had.
import { createHash } from "node:crypto";
import type { Attachment, ImageContentLike } from "./attachments.ts";
import type { TspNode } from "./tsp.ts";

// Tern labels context-menu entries from the action name ("Edit message", "Resend message"); the event's node id
// names the message, as the attachment chip's "remove-attachment" does.
export const MESSAGE_EDIT = "edit-message";
export const MESSAGE_RESEND = "resend-message";
export const MESSAGE_FOCUS = "message.focus";
export const MESSAGE_EDIT_CANCEL = "message.edit.cancel";

export interface UserEntry { id: string; text: string; images: ImageContentLike[] }
export interface EditState { itemId: string; entry: UserEntry; draftBefore: string; attachmentsBefore: Attachment[] }

// `msg-<item>`, `msg-<item>.edit`, `msg-<item>.actions`: item ids (m12, n3, Pi entry ids) never contain a dot.
export function messageItemFromNode(id: unknown): string | undefined {
	if (typeof id !== "string" || !id.startsWith("msg-")) return undefined;
	return id.slice(4).split(".")[0] || undefined;
}

// Your messages on the current branch, in order, as Pi persisted them (the model text, not the typed line).
export function userEntriesOf(branch: readonly unknown[]): UserEntry[] {
	const out: UserEntry[] = [];
	for (const raw of branch) {
		const e = raw as { id?: unknown; type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
		if (!e || e.type !== "message" || e.message?.role !== "user" || typeof e.id !== "string") continue;
		const content = e.message.content;
		const parts = Array.isArray(content) ? content : [{ type: "text", text: typeof content === "string" ? content : "" }];
		const text = parts.filter((p) => p?.type === "text").map((p) => String(p.text ?? "")).join("");
		const images = parts.filter((p) => p?.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string").map((p) => ({ type: "image" as const, data: p.data as string, mimeType: p.mimeType as string }));
		out.push({ id: e.id, text, images });
	}
	return out;
}

// The Pi entry behind a transcript bubble. A restored bubble's id is the entry id; a live one (m12, n3) is matched by
// position, which holds because the transcript shows exactly the branch's user messages once a turn has settled.
// A count mismatch means the two disagree, so no guess is made.
export function resolveUserEntry(itemId: string, transcriptUserIds: readonly string[], entries: readonly UserEntry[]): UserEntry | undefined {
	const direct = entries.find((e) => e.id === itemId);
	if (direct) return direct;
	const i = transcriptUserIds.indexOf(itemId);
	if (i < 0 || transcriptUserIds.length !== entries.length) return undefined;
	return entries[i];
}

// The message's images back as composer chips, so an edit sends them again unless removed.
export function imageAttachments(images: readonly ImageContentLike[], firstN: number): Attachment[] {
	return images.map((img, i) => {
		const id = createHash("sha256").update(Buffer.from(img.data, "base64")).digest("hex");
		return { n: firstN + i, kind: "image", path: `image ${i + 1}`, name: `image ${i + 1}`, blob: { id, mime: img.mimeType, base64: img.data } };
	});
}

const button = (id: string, label: string, act: string, tone: string, title: string, keys?: string): TspNode => ({
	id, k: "text", p: { role: "pi.user.action", wrap: "none", title, aria: title, actions: { click: act }, spans: [{ t: label, s: tone }, ...(keys ? [{ t: ` ${keys}`, s: "dim" }] : [])] },
});

// Under a focused bubble: what you can do with it. Copy is Tern's own action (it copies the message's Markdown).
export function messageActionRow(itemId: string, busy: boolean): TspNode {
	const id = `msg-${itemId}`;
	const why = "Wait for the current turn to finish (Esc stops it)";
	return {
		id: `${id}.actions`, k: "row", p: { role: "pi.user.actions", gap: "md", align: "center" },
		c: busy
			? [{ id: `${id}.busy`, k: "text", p: { role: "pi.user.action", tone: "muted", wrap: "none", text: why } }, button(`${id}.copy`, "Copy", "copy", "muted", "Copy this message")]
			: [
				button(`${id}.edit`, "Edit", MESSAGE_EDIT, "accent", "Edit in the composer; sending branches from here and keeps the original in /tree"),
				button(`${id}.resend`, "Resend", MESSAGE_RESEND, "accent", "Send this message again from here; the previous reply stays in /tree"),
				button(`${id}.copy`, "Copy", "copy", "muted", "Copy this message"),
			],
	};
}

// Above the composer while editing: which message, and how to back out.
export function editingBanner(edit: EditState): TspNode {
	const preview = edit.entry.text.replace(/\s+/g, " ").trim();
	return {
		id: "editing-banner", k: "row", p: { role: "pi.editing", gap: "sm", align: "center", title: "Sending branches from this message; the original stays in /tree" },
		c: [
			{ id: "editing-banner-text", k: "text", p: { wrap: "none", truncate: "end", grow: 1, spans: [{ t: "Editing message", s: "accent strong" }, { t: "  ·  ", s: "muted" }, { t: preview, s: "dim" }] } },
			{ id: "editing-banner-cancel", k: "text", p: { wrap: "none", basis: "content", min: { w: "9ch" }, title: "Cancel editing", actions: { click: MESSAGE_EDIT_CANCEL }, spans: [{ t: "esc", s: "key" }, { t: " cancel", s: "muted" }] } },
		],
	};
}
