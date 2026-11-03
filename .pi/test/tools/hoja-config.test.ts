import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe as group, expect, it } from "vitest";
import { findHojaRepositoryRoot, readHojaConfigForRepository, writeHojaProjectMapping } from "../../../extensions/hoja-mode/project.ts";

/** A throwaway checkout: `.git` marks the root, and the session lives in a nested directory. */
function repository(): { root: string; subdir: string } {
	const root = mkdtempSync(join(tmpdir(), "hoja-config-"));
	mkdirSync(join(root, ".git"));
	const subdir = join(root, "packages", "app");
	mkdirSync(subdir, { recursive: true });
	return { root, subdir };
}

const configPath = (root: string) => join(root, ".pi", "config", "hoja.json");

group("repository mapping location", () => {
	it("writes and reads the mapping at the repository root from a subdirectory session", () => {
		const { root, subdir } = repository();
		// macOS reports /var through /private/var; the resolver intentionally returns the real path.
		const realRoot = realpathSync(root);
		expect(findHojaRepositoryRoot(subdir)).toBe(realRoot);

		const written = writeHojaProjectMapping("Trebol", subdir);
		expect(written).toEqual({ ok: true, path: configPath(realRoot) });
		expect(JSON.parse(readFileSync(configPath(realRoot), "utf8"))).toEqual({ project: "Trebol" });
		expect(readHojaConfigForRepository(subdir).project).toBe("Trebol");
	});

	it("refuses to write outside a repository", () => {
		const outside = mkdtempSync(join(tmpdir(), "hoja-norepo-"));
		expect(findHojaRepositoryRoot(outside)).toBeUndefined();
		expect(writeHojaProjectMapping("Trebol", outside)).toEqual({ ok: false, reason: "no_repository" });
	});
});

group("existing configuration is never clobbered", () => {
	it("preserves unknown keys and the assignee", () => {
		const { root } = repository();
		mkdirSync(join(root, ".pi", "config"), { recursive: true });
		const original = { project: "Hoja", assignee: "luis", extra: { nested: [1, 2] }, flag: true };
		writeFileSync(configPath(root), JSON.stringify(original));

		expect(writeHojaProjectMapping("Trebol", root).ok).toBe(true);
		expect(JSON.parse(readFileSync(configPath(root), "utf8"))).toEqual({ ...original, project: "Trebol" });
	});

	it("refuses a malformed document instead of replacing it", () => {
		const { root } = repository();
		mkdirSync(join(root, ".pi", "config"), { recursive: true });
		writeFileSync(configPath(root), "{ this is not json");

		expect(writeHojaProjectMapping("Trebol", root)).toEqual({ ok: false, reason: "invalid_existing" });
		expect(readFileSync(configPath(root), "utf8")).toBe("{ this is not json");
	});

	it("refuses a symlinked config path, leaving the target untouched", () => {
		const { root } = repository();
		const outside = mkdtempSync(join(tmpdir(), "hoja-outside-"));
		writeFileSync(join(outside, "hoja.json"), '{"project":"Outside"}');
		mkdirSync(join(root, ".pi", "config"), { recursive: true });
		symlinkSync(join(outside, "hoja.json"), configPath(root));

		expect(writeHojaProjectMapping("Trebol", root)).toEqual({ ok: false, reason: "symlinked" });
		expect(readFileSync(join(outside, "hoja.json"), "utf8")).toBe('{"project":"Outside"}');
	});
});
