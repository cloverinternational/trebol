import { describe, expect, test } from "vitest";
import {
	ANNOTATE_COLS,
	ANNOTATE_CURSOR_ID,
	ANNOTATE_IMAGE_ID,
	ANNOTATE_NOTE_ID,
	ANNOTATE_ROWS,
	ANNOTATE_STAGE_ID,
	addMark,
	annotateNodes,
	annotatePayload,
	annotatePng,
	annotateSession,
	annotateSheet,
	cellFromNodeId,
	cellNodeId,
	cellPoint,
	editNote,
	nudgeCursor,
	pinFromNodeId,
	pinNodeId,
	removeSelected,
	selectPin,
	type AnnotateSession,
} from "../../lib/tern/annotate.ts";
import { decodePng, encodePng } from "../../lib/tern/png-crop.ts";
import { artifactFromNodeId, artifactNodes, type ArtifactPreview } from "../../lib/tern/artifact-previews.ts";

function solidPng(width = 200, height = 100, rgb: [number, number, number] = [250, 250, 250]): Buffer {
	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = rgb[0];
		rgba[i + 1] = rgb[1];
		rgba[i + 2] = rgb[2];
		rgba[i + 3] = 255;
	}
	return encodePng({ width, height, rgba });
}

function session(marks: AnnotateSession["marks"] = []): AnnotateSession {
	const base = annotateSession("blob-1", "shot.png", "/tmp/shot.png", "image/png", solidPng());
	base.marks = marks;
	return base;
}

describe("grid coordinates", () => {
	test("a cell centre round-trips through its node id", () => {
		for (const [row, col] of [[0, 0], [4, 7], [ANNOTATE_ROWS - 1, ANNOTATE_COLS - 1]]) {
			expect(cellFromNodeId(cellNodeId(row, col))).toEqual({ row, col });
			const point = cellPoint(row, col);
			expect(point.x).toBeGreaterThan(0);
			expect(point.y).toBeGreaterThan(0);
			expect(point.x).toBeLessThan(1);
			expect(point.y).toBeLessThan(1);
		}
	});

	test("the first cell centre is half a cell in, the last is half a cell from the edge", () => {
		expect(cellPoint(0, 0)).toEqual({ x: 0.5 / ANNOTATE_COLS, y: 0.5 / ANNOTATE_ROWS });
		const last = ANNOTATE_ROWS - 1;
		const right = ANNOTATE_COLS - 1;
		expect(cellPoint(last, right)).toEqual({ x: (right + 0.5) / ANNOTATE_COLS, y: (last + 0.5) / ANNOTATE_ROWS });
	});

	test("unrelated ids and out-of-range cells are refused", () => {
		expect(cellFromNodeId("annotate-pin-1")).toBeUndefined();
		expect(cellFromNodeId("annotate-cell-9-0")).toBeUndefined();
		expect(cellFromNodeId("annotate-cell-0-16")).toBeUndefined();
		expect(cellFromNodeId("composer")).toBeUndefined();
		expect(cellFromNodeId(7)).toBeUndefined();
	});

	test("pin ids parse, and a pin node is not a cell", () => {
		expect(pinFromNodeId(pinNodeId(3))).toBe(3);
		expect(pinFromNodeId("annotate-pin-0")).toBeUndefined();
		expect(pinFromNodeId("annotate-cell-0-0")).toBeUndefined();
	});
});

describe("session source", () => {
	test("a PNG declares its real size", () => {
		const s = annotateSession("b", "shot.png", "/tmp/shot.png", "image/png", solidPng(320, 180));
		expect(s.source).toMatchObject({ width: 320, height: 180, decodable: true });
	});

	test("an SVG declares width/height, falls back to viewBox, and is not decodable", () => {
		const sized = annotateSession("b", "mock.svg", "/tmp/mock.svg", "image/svg+xml", Buffer.from('<svg width="240" height="120"></svg>'));
		expect(sized.source).toMatchObject({ width: 240, height: 120, decodable: false });
		const boxed = annotateSession("b", "mock.svg", "/tmp/mock.svg", "image/svg+xml", Buffer.from('<svg viewBox="0 0 640 360"></svg>'));
		expect(boxed.source).toMatchObject({ width: 640, height: 360 });
	});

	test("an unknown format falls back to 16:9 instead of refusing to open", () => {
		const s = annotateSession("b", "shot.jpg", "/tmp/shot.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff]));
		expect(s.source).toMatchObject({ width: 1600, height: 900, decodable: false });
	});
});

describe("marks", () => {
	test("a mark lands on the cursor and numbers count up", () => {
		const s = session();
		s.cursor = { x: 0.2, y: 0.3 };
		addMark(s);
		s.cursor = { x: 0.8, y: 0.6 };
		addMark(s);
		expect(s.marks.map((m) => [m.n, m.x, m.y])).toEqual([[1, 0.2, 0.3], [2, 0.8, 0.6]]);
		expect(s.selected).toBe(2);
	});

	test("removing a mark renumbers the later ones so the picture stays 1..n", () => {
		const s = session([
			{ n: 1, x: 0.1, y: 0.1, note: "a" },
			{ n: 2, x: 0.2, y: 0.2, note: "b" },
			{ n: 3, x: 0.3, y: 0.3, note: "c" },
		]);
		s.selected = 2;
		expect(removeSelected(s)).toBe(true);
		expect(s.marks.map((m) => [m.n, m.note])).toEqual([[1, "a"], [2, "c"]]);
		expect(s.selected).toBe(2);
		expect(s.note).toBe("c");
	});

	test("removing with nothing selected is a no-op", () => {
		const s = session([{ n: 1, x: 0.1, y: 0.1, note: "" }]);
		expect(removeSelected(s)).toBe(false);
		expect(s.marks).toHaveLength(1);
	});

	test("selecting a pin loads its note for editing", () => {
		const s = session([{ n: 1, x: 0, y: 0, note: "not here" }]);
		expect(selectPin(s, 1)).toBe(true);
		expect(s.note).toBe("not here");
		expect(s.noteCursor).toBe("not here".length);
		expect(selectPin(s, 9)).toBe(false);
	});

	test("a native edit replaces the range and writes through to the mark", () => {
		const s = session([{ n: 1, x: 0, y: 0, note: "not here" }]);
		selectPin(s, 1);
		// Replace "here" with "there".
		expect(editNote(s, 4, 8, "there", 9)).toBe(true);
		expect(s.note).toBe("not there");
		expect(s.marks[0].note).toBe("not there");
		expect(s.noteCursor).toBe(9);
	});

	test("an edit without a selected mark changes nothing", () => {
		const s = session();
		expect(editNote(s, 0, 0, "x")).toBe(false);
		expect(s.note).toBe("");
	});

	test("arrow nudges round to whole percent and clamp at the edges", () => {
		const s = session();
		s.cursor = { x: 0.5, y: 0.5 };
		nudgeCursor(s, 0.01, -0.01);
		expect(s.cursor).toEqual({ x: 0.51, y: 0.49 });
		nudgeCursor(s, -2, -2);
		expect(s.cursor).toEqual({ x: 0, y: 0 });
		nudgeCursor(s, 5, 5);
		expect(s.cursor).toEqual({ x: 1, y: 1 });
	});
});

describe("payload", () => {
	test("carries the percentages, the notes and the exact normalized marks", () => {
		const s = session([
			{ n: 1, x: 0.423, y: 0.181, note: "move this left" },
			{ n: 2, x: 0.05, y: 0.9, note: "" },
		]);
		const payload = annotatePayload(s);
		expect(payload).toContain("shot.png (200×100)");
		expect(payload).toContain("1. 42.3%, 18.1% — move this left");
		expect(payload).toContain("2. 5.0%, 90.0%");
		const json = /```json\n(.*)\n```/.exec(payload)?.[1];
		expect(json).toBeTruthy();
		expect(JSON.parse(json ?? "{}")).toEqual({
			source: "shot.png",
			path: "/tmp/shot.png",
			width: 200,
			height: 100,
			marks: [
				{ n: 1, x: 0.423, y: 0.181, note: "move this left" },
				{ n: 2, x: 0.05, y: 0.9, note: "" },
			],
		});
	});

	test("names the marked copy's path, so the image is not the only way to read the marks", () => {
		const s = session([{ n: 1, x: 0.5, y: 0.5, note: "here" }]);
		const payload = annotatePayload(s, "artifacts/annotations/shot-annotated-x.png");
		expect(payload).toContain("Saved copy: artifacts/annotations/shot-annotated-x.png");
		const json = /```json\n(.*)\n```/.exec(payload)?.[1];
		expect(JSON.parse(json ?? "{}").annotated).toBe("artifacts/annotations/shot-annotated-x.png");
	});

	test("does not claim a copy when none was written", () => {
		expect(annotatePayload(session([{ n: 1, x: 0.5, y: 0.5, note: "" }]))).not.toContain("Saved copy:");
	});
});

describe("overlay copy", () => {
	test("burns a dark disc with a white halo at the mark and leaves the rest of the picture alone", () => {
		const source = solidPng(200, 100);
		const marked = annotatePng(source, [{ n: 1, x: 0.5, y: 0.5, note: "" }]);
		expect(marked).toBeTruthy();
		const before = decodePng(source);
		const after = decodePng(marked!);
		expect(after.width).toBe(200);
		expect(after.height).toBe(100);
		const at = (image: { width: number; rgba: Buffer }, x: number, y: number) => {
			const i = (y * image.width + x) * 4;
			return [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]];
		};
		// The digit sits at the centre, so sample the disc beside the glyph: dark ink, white halo outside it.
		expect(at(after, 107, 50)).toEqual([24, 24, 24]);
		expect(at(after, 100, 50)).toEqual([255, 255, 255]);
		expect(at(before, 100, 50)).toEqual([250, 250, 250]);
		// A corner far from the mark keeps the original pixel.
		expect(at(after, 2, 2)).toEqual([250, 250, 250]);
		// The halo is a white ring just outside the disc radius.
		expect(at(after, 111, 50)).toEqual([255, 255, 255]);
	});

	test("a format this machine cannot decode is refused rather than sent unmarked", () => {
		expect(annotatePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), [{ n: 1, x: 0.5, y: 0.5, note: "" }])).toBeUndefined();
	});

	test("no marks returns the picture unchanged", () => {
		const source = solidPng();
		expect(annotatePng(source, [])?.equals(source)).toBe(true);
	});
});

describe("sheet", () => {
	test("matches the picture's aspect ratio and places rows, pins and the crosshair", () => {
		const s = session([{ n: 1, x: 0.25, y: 0.75, note: "" }]);
		s.cursor = { x: 0.5, y: 0.5 };
		s.selected = 1;
		const css = annotateSheet(s);
		// 100/200 = 50% padding — the stage is as tall as the picture, so percentages mean picture space.
		expect(css).toContain(`[data-id="${ANNOTATE_STAGE_ID}"]{position:relative;width:100%;padding-top:50.000%`);
		expect(css).toContain(`[data-id="${ANNOTATE_IMAGE_ID}"]{position:absolute`);
		expect(css).toContain(`[data-id="annotate-row-8"]{position:absolute;left:0;top:88.89%`);
		expect(css).toContain(`[data-id="annotate-pin-1"]{left:25.00%;top:75.00%;outline:2px solid var(--accent)}`);
		expect(css).toContain(`[data-id="${ANNOTATE_CURSOR_ID}"]{position:absolute;left:50.00%;top:50.00%`);
	});

	test("no pins still yields the stage, the rows and the crosshair", () => {
		const css = annotateSheet(session());
		expect(css).toContain(ANNOTATE_STAGE_ID);
		expect(css).toContain("annotate-row-0");
		expect(css).toContain(ANNOTATE_CURSOR_ID);
		expect(css).not.toContain('[data-id="annotate-pin-1"]');
	});
});

describe("card", () => {
	test("draws the picture, a clickable grid, the pins, the crosshair, a note field and controls", () => {
		const s = session([{ n: 1, x: 0.3, y: 0.4, note: "wrong place" }]);
		selectPin(s, 1);
		const [card] = annotateNodes(s);
		expect(card.id).toBe("annotate-card");
		expect(String(card.p?.head)).toContain("shot.png");
		const stage = card.c?.find((node) => node.id === ANNOTATE_STAGE_ID);
		expect(stage?.k).toBe("el");
		const ids = new Set((stage?.c ?? []).map((node) => node.id));
		expect(ids.has(ANNOTATE_IMAGE_ID)).toBe(true);
		expect(ids.has(ANNOTATE_CURSOR_ID)).toBe(true);
		expect(ids.has(pinNodeId(1))).toBe(true);
		// Cells tile the picture inside per-row flex rows, so they are one level deeper than the stage.
		const cells = (stage?.c ?? []).flatMap((node) => (node.c ?? []).filter((child) => child.id.startsWith("annotate-cell-")));
		expect(cells).toHaveLength(ANNOTATE_COLS * ANNOTATE_ROWS);
		expect(cells[0].p?.actions).toEqual({ click: "annotate.cell" });
		const note = card.c?.find((node) => node.id === ANNOTATE_NOTE_ID);
		expect(note?.k).toBe("editor");
		expect(note?.p?.text).toBe("wrong place");
		const controls = card.c?.find((node) => node.id === "annotate-controls");
		const send = controls?.c?.find((node) => node.id === "annotate-send");
		expect(send?.p?.actions).toEqual({ click: "annotate.send" });
	});

	test("send is disabled with no marks and says how many will go", () => {
		const empty = annotateNodes(session())[0].c?.find((node) => node.id === "annotate-controls");
		const disabled = empty?.c?.find((node) => node.id === "annotate-send");
		expect(disabled?.p?.actions).toBeUndefined();
		const one = annotateNodes(session([{ n: 1, x: 0.5, y: 0.5, note: "" }]))[0].c?.find((node) => node.id === "annotate-controls");
		const send = one?.c?.find((node) => node.id === "annotate-send");
		expect(send?.p?.actions).toEqual({ click: "annotate.send" });
		expect(JSON.stringify(send?.p?.spans)).toContain("Send 1 mark");
	});

	test("the hint states the live crosshair position", () => {
		const s = session();
		s.cursor = { x: 0.42, y: 0.18 };
		const hint = annotateNodes(s)[0].c?.find((node) => node.id === "annotate-hint");
		expect(hint?.p?.text).toContain("42%, 18%");
	});
});

describe("artifact card action", () => {
	const preview: ArtifactPreview = { name: "shot.png", path: "/tmp/shot.png", citation: "Cite: shot.png", blob: { id: "abc", mime: "image/png", base64: "" } };

	test("a picture card offers Mark up with its own item and index", () => {
		const [card] = artifactNodes("t-c1", [preview]);
		const action = card.c?.find((node) => node.id === "t-c1-art-0-annotate");
		expect(action?.p?.actions).toEqual({ click: "artifact.annotate" });
		expect(artifactFromNodeId("t-c1-art-0-annotate")).toEqual({ itemId: "t-c1", index: 0 });
		expect(artifactFromNodeId("t-c1-art-12-annotate")).toEqual({ itemId: "t-c1", index: 12 });
		expect(artifactFromNodeId("t-c1-art-0")).toBeUndefined();
		expect(artifactFromNodeId("annotate-pin-1")).toBeUndefined();
	});

	test("a preview with no blob offers the reason instead of a dead action", () => {
		const [card] = artifactNodes("t-c1", [{ name: "big.png", path: "/tmp/big.png", citation: "Cite: big.png", reason: "too big" }]);
		expect(card.c?.some((node) => node.id === "t-c1-art-0-annotate")).toBe(false);
	});
});
