
import { describe, expect, it } from "vitest";
import {
	capabilitiesFor,
	herdrServerRunning,
	parseVersion,
	probePaneRuntime,
	resolveBinary,
	searchDirs,
	wellKnownDirs,
} from "../../lib/panes/install-probe.ts";

const node = process.execPath;

describe("searchDirs", () => {
	it("keeps PATH order, then appends the well-known directories", () => {
		const dirs = searchDirs({ PATH: "/a:/b" }, "/home/u", "linux");
		expect(dirs.slice(0, 2)).toEqual(["/a", "/b"]);
		expect(dirs).toContain("/home/u/.local/bin");
	});

	it("de-duplicates and drops relative entries", () => {
		const dirs = searchDirs({ PATH: "/a:/a:relative:/usr/bin" }, "/home/u", "linux");
		expect(dirs.filter((dir) => dir === "/a")).toHaveLength(1);
		expect(dirs).not.toContain("relative");
		// /usr/bin is on PATH already, so the well-known copy must not duplicate it.
		expect(dirs.filter((dir) => dir === "/usr/bin")).toHaveLength(1);
	});

	it("uses the homebrew prefix on macOS", () => {
		expect(wellKnownDirs("/home/u", "darwin")).toContain("/opt/homebrew/bin");
	});
});

describe("resolveBinary", () => {
	it("prefers an explicit override that is executable", () => {
		const found = resolveBinary(["definitely-not-here"], { env: { PATH: "" }, home: "/home/u", override: node });
		expect(found).toBe(node);
	});

	it("ignores an override that is not an executable file", () => {
		const found = resolveBinary(["definitely-not-here"], { env: { PATH: "" }, home: "/home/u", override: "/etc/hostname" });
		expect(found).toBeUndefined();
	});

	it("returns undefined when nothing matches", () => {
		expect(resolveBinary(["definitely-not-here"], { env: { PATH: "/nonexistent" }, home: "/home/u" })).toBeUndefined();
	});
});

describe("parseVersion", () => {
	it("reads the version out of a real banner", () => {
		expect(parseVersion("tern 0.9.12 (e498b49)")).toBe("0.9.12");
		expect(parseVersion("herdr 0.9.5")).toBe("0.9.5");
	});

	it("returns undefined when there is no version", () => {
		expect(parseVersion("no numbers here")).toBeUndefined();
	});
});

describe("herdrServerRunning", () => {
	it("reads the status line from the server block", () => {
		const text = ["client:", "  version: 0.9.5", "", "server:", "  status: running", "  version: 0.9.5", "", "update:", "  restart_needed: no"].join("\n");
		expect(herdrServerRunning(text)).toBe(true);
	});

	it("is false when the server block says it is down", () => {
		const text = ["client:", "  version: 0.9.5", "", "server:", "  status: not running", "  socket: /tmp/herdr.sock"].join("\n");
		expect(herdrServerRunning(text)).toBe(false);
	});

	it("does not read a client status line", () => {
		const text = ["client:", "  status: running", "", "server:", "  status: not running"].join("\n");
		expect(herdrServerRunning(text)).toBe(false);
	});

	it("is false for missing or shapeless output", () => {
		expect(herdrServerRunning(undefined)).toBe(false);
		expect(herdrServerRunning("")).toBe(false);
		expect(herdrServerRunning("ok")).toBe(false);
	});
});

describe("capabilitiesFor", () => {
	it("exposes a browser surface only for tern", () => {
		expect(capabilitiesFor("tern")).toEqual({ panes: true, browser: true });
		expect(capabilitiesFor("herdr")).toEqual({ panes: true, browser: false });
		expect(capabilitiesFor("none")).toEqual({ panes: false, browser: false });
	});
});

describe("probePaneRuntime", () => {
	const versionOf = async () => "1.2.3";
	const statusUp = async (): Promise<string> => "server:\n  status: running";

	it("prefers tern and reports a browser surface", async () => {
		const probe = await probePaneRuntime({
			env: { PATH: "", PI_SWARM_TERN_BIN: node, PI_SWARM_HERDR_BIN: node },
			home: "/home/u",
			versionOf,
			herdrStatusOf: statusUp,
		});
		expect(probe.backend).toBe("tern");
		expect(probe.capabilities).toEqual({ panes: true, browser: true });
		expect(probe.tern?.version).toBe("1.2.3");
	});

	it("falls back to herdr with no browser surface", async () => {
		const probe = await probePaneRuntime({
			env: { PATH: "", PI_SWARM_HERDR_BIN: node },
			home: "/home/u",
			versionOf,
			herdrStatusOf: statusUp,
		});
		expect(probe.backend).toBe("herdr");
		expect(probe.capabilities).toEqual({ panes: true, browser: false });
		expect(probe.herdr?.serverRunning).toBe(true);
	});

	it("reports none when neither runtime answers", async () => {
		const probe = await probePaneRuntime({ env: { PATH: "" }, home: "/home/u", versionOf });
		expect(probe.backend).toBe("none");
		expect(probe.capabilities).toEqual({ panes: false, browser: false });
	});

	it("treats a binary that fails --version as absent instead of throwing", async () => {
		const probe = await probePaneRuntime({
			env: { PATH: "", PI_SWARM_TERN_BIN: node },
			home: "/home/u",
			versionOf: async () => {
				throw new Error("boom");
			},
		});
		expect(probe.backend).toBe("none");
	});

	it("reports the directories it searched, so an error can say where it looked", async () => {
		const probe = await probePaneRuntime({ env: { PATH: "/only/here" }, home: "/home/u", versionOf });
		expect(probe.searched[0]).toBe("/only/here");
		expect(probe.searched).toContain("/home/u/.local/bin");
	});
});

describe("detectBackendSync", () => {
	it("finds tern ahead of herdr when both are reachable", async () => {
		const { detectBackendSync } = await import("../../lib/panes/install-probe.ts");
		const found = detectBackendSync({ env: { PATH: "", PI_SWARM_TERN_BIN: node, PI_SWARM_HERDR_BIN: node }, home: "/home/u" });
		expect(found.backend).toBe("tern");
		expect(found.capabilities.browser).toBe(true);
		expect(found.herdrPath).toBeUndefined();
	});

	it("reports herdr when only herdr is reachable, without a version spawn", async () => {
		const { detectBackendSync } = await import("../../lib/panes/install-probe.ts");
		const found = detectBackendSync({ env: { PATH: "", PI_SWARM_HERDR_BIN: node }, home: "/home/u" });
		expect(found.backend).toBe("herdr");
		expect(found.capabilities).toEqual({ panes: true, browser: false });
	});

	it("reports none for an empty search path", async () => {
		const { detectBackendSync } = await import("../../lib/panes/install-probe.ts");
		expect(detectBackendSync({ env: { PATH: "" }, home: "/home/u" }).backend).toBe("none");
	});
});
