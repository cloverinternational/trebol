import { describe, expect, it } from "vitest";
import { composerNodes, contextThresholds, formatCount, modelDisplayName } from "../../lib/tern/composer-view.ts";
import { parseGitStatus } from "../../lib/tern/git-facts.ts";

const find = (nodes: any[], id: string): any => {
	for (const n of nodes) {
		if (n.id === id) return n;
		const hit = n.c && find(n.c, id);
		if (hit) return hit;
	}
	return undefined;
};

describe("OMP composer port", () => {
	it("formats counts like OMP's De()", () => {
		expect([999, 1500, 1000, 200_000, 1_200_000, 25_000_000].map(formatCount)).toEqual(["999", "1.5K", "1K", "200K", "1.2M", "25M"]);
	});

	it("uses OMP's context thresholds", () => {
		expect(contextThresholds(200_000)).toEqual({ warn: 0.5, bad: 0.9 });
		expect(contextThresholds(1_000_000)).toEqual({ warn: 0.15, bad: 0.5 });
	});

	it("drops the Claude prefix from model names like OMP", () => {
		expect(modelDisplayName({ id: "claude-haiku", name: "Claude Haiku 4.5" })).toBe("Haiku 4.5");
		expect(modelDisplayName({ id: "gpt-x" })).toBe("gpt-x");
	});

	it("shows the turn's own clock while it runs, and nothing while idle", () => {
		const bar = (facts: Record<string, unknown>) => {
			const [col] = composerNodes({ draft: "", busy: false, ...facts } as never);
			const barNode = (col.c ?? []).find((n: any) => n.p?.role === "omp.composer.bar")!;
			return (barNode.c ?? []).map((n: any) => n.id);
		};
		expect(bar({ busy: true, turnAgeMs: 4200 })).toContain("composer-turn");
		// Tern counts the timer on from `age`, so the node carries no text and no ticking frame is needed.
		const [col] = composerNodes({ draft: "", busy: true, turnAgeMs: 4200 });
		expect(find([col], "composer-turn")?.p).toMatchObject({ age: 4200, format: "short", role: "omp.composer.turn" });
		// Idle, or a turn whose start was never observed: no clock is invented.
		expect(bar({ busy: false, turnAgeMs: 4200 })).not.toContain("composer-turn");
		expect(bar({ busy: true })).not.toContain("composer-turn");
	});

	it("mirrors OMP's dock frame for the same facts", () => {
		const [col] = composerNodes({
			draft: "",
			busy: false,
			context: { tokens: 36_000, window: 200_000, compactAt: 85 },
			model: "Haiku 5.5",
			effortKind: true,
			git: { branch: "main", staged: 0, unstaged: 2, untracked: 26 },
		});
		expect(col.p.role).toBe("omp.editor");
		expect(col.c.map((n: any) => n.p.role)).toEqual(["omp.composer.context", "omp.composer.line", "omp.composer.bar"]);
		const ctx = find([col], "ctx");
		expect(ctx.p).toMatchObject({ label: "18%", total: "200K", thresholds: { warn: 0.5, bad: 0.9 }, marks: [{ at: 0.85, icon: "context.compaction" }] });
		expect(find([col], "composer-bar").c.map((n: any) => n.p.role)).toEqual(["omp.composer.model", "omp.composer.extras", "omp.composer.usage", "omp.composer.send"]);
		expect(find([col], "git").p.spans.map((s: any) => s.t).join("")).toBe("main *2 ?26");
		expect(find([col], "usage").p.text).toBe("");
	});

	it("folds the effort glyph into the model chip when Tern has the effort kind, else a separate chip", () => {
		const base = { draft: "", busy: false, model: "M", thinking: "high" };
		expect(find(composerNodes({ ...base, effortKind: true }), "model-effort")?.k).toBe("effort");
		const plain = composerNodes({ ...base, effortKind: false });
		expect(find(plain, "model-icon")?.k).toBe("icon");
		expect(find(plain, "effort")?.p.role).toBe("omp.composer.effort");
	});

	it("swaps send for Stop while running, and shows real cost", () => {
		const nodes = composerNodes({ draft: "", busy: true, effortKind: false, cost: 0.134 });
		expect(find(nodes, "stop")?.p.role).toBe("omp.composer.stop");
		expect(find(nodes, "send")).toBeUndefined();
		expect(find(nodes, "usage").p.text).toBe("$0.13");
		expect(find(nodes, "composer-col").p.tone).toBe("pending");
	});

	it("turns the keycap into a labelled Send touch target on a phone-width bar", () => {
		const nodes = composerNodes({
			draft: "hello",
			busy: false,
			compact: true,
			model: "Haiku 5.5",
			cost: 0.42,
			git: { branch: "main", staged: 0, unstaged: 2, untracked: 0 },
			backgroundable: true,
		});
		expect(find(nodes, "send")?.p).toMatchObject({ role: "pi.composer.send", text: "Send", actions: { click: "submit" } });
		// Secondary facts move out rather than clipping the primary action; the context meter above stays.
		expect(find(nodes, "git")).toBeUndefined();
		expect(find(nodes, "usage")).toBeUndefined();
		expect(find(nodes, "composer-background")).toBeUndefined();
		expect(find(nodes, "composer-bar").c.map((n: any) => n.p.role)).toEqual(["omp.composer.model", "omp.composer.extras", "pi.composer.send"]);
	});

	it("parses git status --porcelain -b", () => {
		expect(parseGitStatus("## main...origin/main [ahead 1]\n M a\nM  b\nMM c\n?? d\n")).toEqual({ branch: "main", staged: 2, unstaged: 2, untracked: 1 });
		expect(parseGitStatus("## No commits yet on dev\n")).toEqual({ branch: "dev", staged: 0, unstaged: 0, untracked: 0 });
		expect(parseGitStatus("## HEAD (no branch)\n")?.branch).toBeUndefined();
		expect(parseGitStatus("")).toBeUndefined();
	});

	it("counts an unmerged file once, and never as staged work", () => {
		// Real output from a scratch repo mid-merge: one conflicted file, unmerged in both columns.
		expect(parseGitStatus("## main\nUU both.txt\n")).toEqual({ branch: "main", staged: 0, unstaged: 1, untracked: 0 });
		// The other unmerged pairs are conflicts too; only a clean "A " / "M " is staged work.
		expect(parseGitStatus("## main\nAU added.txt\nDD gone.txt\n")).toEqual({ branch: "main", staged: 0, unstaged: 2, untracked: 0 });
		// The bar must not show a green "+n" for a conflict: nothing there can be committed as-is.
		const git = parseGitStatus("## main\nUU both.txt\n");
		const seg = find(composerNodes({ draft: "", busy: false, effortKind: false, git }), "git")!;
		expect(seg.p.spans.map((s: any) => s.t).join("")).toBe("main *1");
		// One conflicted file keeps the branch dirty, so the seg stays warning-toned and is never dropped.
		expect(seg.p.tone).toBe("warning");
	});
});

describe("OMP composer fact parity", () => {
	it("tones a dirty git seg warning and gives every fact OMP's click action", () => {
		const nodes = composerNodes({ draft: "", busy: false, effortKind: false, model: "M", context: { tokens: 1, window: 10 }, git: { branch: "main", staged: 0, unstaged: 1, untracked: 0 } });
		expect(find(nodes, "git").p).toMatchObject({ tone: "warning", actions: { click: "git.open" } });
		expect(find(nodes, "ctx").p.actions).toEqual({ click: "status.context" });
		expect(find(nodes, "model").p.actions).toEqual({ click: "model.select" });
		// A chip that cannot act is a label: a click that only writes "unavailable" into the transcript is a trap.
		const inert = composerNodes({ draft: "", busy: false, effortKind: false, model: "M", modelSelectable: false });
		expect(find(inert, "model").p.actions).toBeUndefined();
		expect(find(nodes, "usage").p.actions).toEqual({ click: "status.cost" });
		const clean = composerNodes({ draft: "", busy: false, effortKind: false, git: { branch: "main", staged: 0, unstaged: 0, untracked: 0 } });
		expect(find(clean, "git").p.tone).toBeUndefined();
	});
});

describe("composer running-work pulse", () => {
	const facts = (over: Record<string, unknown> = {}) => ({ draft: "", busy: false, effortKind: false, ...over });

	it("sits directly after the git facts in the same slot, and costs no space when work is idle", () => {
		const withWork = composerNodes(facts({
			git: { branch: "main", staged: 0, unstaged: 1, untracked: 0 },
			work: { running: 1, queued: 0, newest: "npm test" },
		}));
		const extras = find(withWork, "extras");
		expect(extras.c.map((n: any) => n.id)).toEqual(["git", "work"]);
		// No work fact, or a phone-width bar, means no node at all — not an empty pulse.
		expect(find(composerNodes(facts()), "work")).toBeUndefined();
		expect(find(composerNodes(facts({ work: { running: 1, queued: 0, newest: "x" }, compact: true })), "work")).toBeUndefined();
	});

	it("shows one counted pulse that Tern clocks, opens the sheet on click, and never floats a card", () => {
		const nodes = composerNodes(facts({ work: { running: 1, queued: 2, newest: "npm test" } }));
		const work = find(nodes, "work");
		expect(work.p).toMatchObject({ role: "pi.composer.work", actions: { click: "bg.open=all" } });
		// The spinner is Tern's own kind: it is clocked by the host, so Pi sends no frames for it.
		expect(find(nodes, "work-pulse")).toMatchObject({ k: "spinner", p: { style: "orbit", tone: "info" } });
		expect(find(nodes, "work-count").p.text).toBe("3");
		expect(find(nodes, "work-now").p.text).toBe(" · npm test");
		// The bar's status band clips its own children, so a hover card there could never paint.
		expect(find(nodes, "work-card")).toBeUndefined();
		// The pulse carries no per-job rows: the sheet is the only place a list is drawn.
		expect(work.c.map((n: any) => n.id)).toEqual(["work-pulse", "work-count", "work-now"]);
	});

	it("draws no name to reveal when the store never published one", () => {
		const nodes = composerNodes(facts({ work: { running: 2, queued: 0 } }));
		expect(find(nodes, "work-count").p.text).toBe("2");
		expect(find(nodes, "work-now")).toBeUndefined();
	});
});
