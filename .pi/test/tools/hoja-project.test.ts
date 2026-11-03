import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOJA_CONFIG_PATH, parseHojaConfig, readHojaConfig } from "../../../extensions/hoja-mode/project.ts";

describe("repository Hoja project configuration", () => {
	const root = () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-config-"));
		mkdirSync(join(dir, ".pi", "config"), { recursive: true });
		return dir;
	};
	const write = (dir: string, body: string) => writeFileSync(join(dir, HOJA_CONFIG_PATH), body);

	it("reads a project and an optional assignee", () => {
		expect(parseHojaConfig('{"project":"Hoja","assignee":"Luis"}')).toEqual({ project: "Hoja", assignee: "Luis" });
		expect(parseHojaConfig('{"project":"  Hoja  "}')).toEqual({ project: "Hoja" });
	});

	it("treats missing, blank, malformed and wrongly shaped configuration as not configured", () => {
		for (const value of [undefined, null, "", "   ", "{", "null", "[]", '"Hoja"', '{"project":42}', '{"project":"  "}', "{}"])
			expect(parseHojaConfig(value as any)).toEqual({});
	});

	it("reads the file from the checkout root", () => {
		const dir = root();
		write(dir, '{"project":"Hoja"}');
		expect(readHojaConfig(dir)).toEqual({ project: "Hoja" });
	});

	it("returns an empty configuration when the file is absent, rather than guessing a project", () => {
		expect(readHojaConfig(root())).toEqual({});
	});
});
