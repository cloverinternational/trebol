import { describe, expect, it } from "vitest";
import { WorkRegistrationPolicy, isActingCall, isUserAuthoredPrompt } from "../../lib/runtime/work-registration.ts";

const focused = [{ id: "1", subject: "Fix divide by zero", status: "in_progress", active: true }];
const done = [{ id: "1", subject: "Fix divide by zero", status: "completed", active: false }];

describe("work registration (HOJA-757)", () => {
	it("treats harness-injected turns as not user-authored", () => {
		expect(isUserAuthoredPrompt("<task-notification> <task-id>b1</task-id>")).toBe(false);
		expect(isUserAuthoredPrompt("<cross-session-message from=\"x\">hi</cross-session-message>")).toBe(false);
		expect(isUserAuthoredPrompt("[SYSTEM NOTIFICATION - NOT USER INPUT]")).toBe(false);
		expect(isUserAuthoredPrompt("")).toBe(false);
		expect(isUserAuthoredPrompt("merge and deploy")).toBe(true);
	});

	it("classifies acting calls", () => {
		expect(isActingCall("Edit", { file_path: "a" })).toBe(true);
		expect(isActingCall("Bash", { command: "git commit -m x" })).toBe(true);
		expect(isActingCall("Bash", { command: "git status" })).toBe(false);
		expect(isActingCall("Read", { file_path: "a" })).toBe(false);
		expect(isActingCall("TaskManage", {})).toBe(false);
		expect(isActingCall("hoja_list", {})).toBe(false);
		expect(isActingCall("WebFetch", {}, true)).toBe(false);
	});

	it("asks for a task on a new request when nothing is tracked, even after earlier tasks completed", () => {
		const p = new WorkRegistrationPolicy();
		expect(p.onUserPrompt("help me clean the disk", [])).toContain("create a TaskManage task");
		// The Swarm task nudge goes silent once any task exists; this line must not.
		expect(p.onUserPrompt("now merge and deploy", done)).toContain("create a TaskManage task");
		expect(p.onUserPrompt("thanks", done)).toBeUndefined();
	});

	it("names the focused task and the root-vs-child choice when a new request arrives mid-task", () => {
		const p = new WorkRegistrationPolicy();
		const line = p.onUserPrompt("also update both READMEs", focused)!;
		expect(line).toContain("#1");
		expect(line).toContain("parentTaskId=\"1\"");
		expect(line).toContain("Do not fold a new request into #1");
		expect(p.onUserPrompt("ok", focused)).toBeUndefined();
	});

	it("lists open tasks when none is active", () => {
		const p = new WorkRegistrationPolicy();
		const line = p.onUserPrompt("go ahead", [{ id: "2", subject: "Write tests", status: "pending" }])!;
		expect(line).toContain("#2");
		expect(line).toContain("in_progress");
	});

	it("does not open a request for a background notification", () => {
		const p = new WorkRegistrationPolicy();
		expect(p.onUserPrompt("<task-notification><status>completed</status></task-notification>", [])).toBeUndefined();
	});

	it("asks once per turn to reconcile a focused task that acting work left unreconciled", () => {
		const p = new WorkRegistrationPolicy();
		p.onUserPrompt("fix it", focused);
		p.onToolResult({ toolName: "Edit", params: {} });
		p.onToolResult({ toolName: "Bash", params: { command: "python3 -m unittest -q" } });
		const text = p.onSettle(focused)!;
		expect(text).toContain("reconcile task #1");
		expect(text).toContain("completed");
		expect(text).toContain("addNote");
		expect(p.onSettle(focused)).toBeUndefined();
	});

	it("stays quiet when the task was updated after the work", () => {
		const p = new WorkRegistrationPolicy();
		p.onUserPrompt("fix it", focused);
		p.onToolResult({ toolName: "Edit", params: {} });
		p.onToolResult({ toolName: "Edit", params: {} });
		p.onToolResult({ toolName: "TaskManage", params: {}, taskManageSucceeded: true });
		expect(p.onSettle(focused)).toBeUndefined();
	});

	it("does not re-nag on a turn that did no work", () => {
		const p = new WorkRegistrationPolicy();
		p.onUserPrompt("fix it", focused);
		p.onToolResult({ toolName: "Edit", params: {} });
		p.onToolResult({ toolName: "Edit", params: {} });
		expect(p.onSettle(focused)).toBeDefined();
		p.onUserPrompt("thanks", focused);
		expect(p.onSettle(focused)).toBeUndefined();
	});

	it("asks to register acting work done without any task", () => {
		const p = new WorkRegistrationPolicy();
		p.onUserPrompt("commit everything", done);
		p.onToolResult({ toolName: "Bash", params: { command: "git add -A" } });
		p.onToolResult({ toolName: "Bash", params: { command: "git commit -m x" } });
		expect(p.onSettle(done)).toContain("without a task");
	});

	it("does not ask when a task tool ran this turn or the work was read-only", () => {
		const p = new WorkRegistrationPolicy();
		p.onUserPrompt("what does parse do?", []);
		p.onToolResult({ toolName: "Read", params: {} });
		p.onToolResult({ toolName: "Grep", params: {} });
		expect(p.onSettle([])).toBeUndefined();
		const q = new WorkRegistrationPolicy();
		q.onUserPrompt("fix it", []);
		q.onToolResult({ toolName: "TaskManage", params: {}, taskManageSucceeded: true });
		q.onToolResult({ toolName: "Edit", params: {} });
		q.onToolResult({ toolName: "Edit", params: {} });
		expect(q.onSettle(done)).toBeUndefined();
	});

	it("never fires before any prompt", () => {
		expect(new WorkRegistrationPolicy().onSettle(focused)).toBeUndefined();
	});
});
