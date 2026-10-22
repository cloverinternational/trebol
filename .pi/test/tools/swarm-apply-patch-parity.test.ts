import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ALLOWLIST, SCENARIOS_DIR, runScenario } from "../../../tools/experiments/patch-parity/runner.ts";

const scenarios = readdirSync(SCENARIOS_DIR).map(n => join(SCENARIOS_DIR, n)).filter(p => statSync(p).isDirectory()).sort();

describe("upstream apply-patch scenario corpus (source-backed fixtures; oracle not executed)", () => {
  it.each(scenarios.map(p => [p.split("/").at(-1)!, p]))("standalone writer matches %s", async (_name, dir) => {
    const result = await runScenario(dir as string, "standalone");
    expect(result.diff).toEqual([]);
  });

  it.each(scenarios.map(p => [p.split("/").at(-1)!, p]))("agent path matches %s or its allowlisted divergence", async (name, dir) => {
    const result = await runScenario(dir as string, "agent");
    if (AGENT_ALLOWLIST[name as string]) expect(result.diff).toEqual(["missing created.txt"]);
    else expect(result.diff).toEqual([]);
  });
});
