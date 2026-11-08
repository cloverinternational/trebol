/**
 * The diagram in docs/architecture/runtime-state-relocation.svg is generated, and this
 * suite is what stops it from becoming a pretty lie:
 *
 *   1. byte-equality with the generator — a hand-edit or silent drift fails;
 *   2. string equality with the real modules — the env names, the workspace key form and
 *      the Claw directory shown in the picture are computed, not asserted by eye;
 *   3. coverage of every outcome `Adoption` can return;
 *   4. an allowlist of `.swarm` paths, so a new "the runtime writes here" claim cannot
 *      slip into the picture unnoticed;
 *   5. the accessibility hooks a screen reader needs.
 */
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRoot, workspaceKey } from "../.pi/lib/state/workspace-state.ts";
import { clawStateDir } from "../.pi/lib/claw/store.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SVG_PATH = join(ROOT, "docs/architecture/runtime-state-relocation.svg");
const GENERATOR = join(ROOT, "tools/docs/runtime-state-diagram.mjs");
const svg = () => readFileSync(SVG_PATH, "utf8");
/** The text a reader sees: XML entities decoded, so assertions read like the drawing. */
const text = () => svg().replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

it("is exactly what the generator emits", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-diagram-"));
  try {
    const out = join(dir, "diagram.svg");
    execFileSync(process.execPath, [GENERATOR, out], { stdio: "pipe" });
    expect(readFileSync(out, "utf8")).toBe(svg());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("shows the paths and environment names the code actually resolves", () => {
  const doc = text();
  const key = workspaceKey("/checkout/app");
  // Same composition the runtime uses: root -> workspaces/<key> -> claw.
  expect(clawStateDir("/checkout/app")).toBe(join(stateRoot(), "workspaces", key, "claw"));
  expect(key).toMatch(/^app-[a-f0-9]{12}$/);
  expect(doc).toContain(`workspaces/${key}`.replace(key, "<basename>-<sha256(path)[0:12]>"));
  expect(doc).toContain("$PI_SWARM_STATE_DIR");
  expect(doc).toContain("$XDG_STATE_HOME/pi-swarm");
  expect(doc).toContain("~/.local/state/pi-swarm");
  // The precedence the picture draws, checked by calling it.
  expect(stateRoot({ PI_SWARM_STATE_DIR: "/explicit", XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe("/explicit");
  expect(stateRoot({ XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe("/xdg/pi-swarm");
  expect(stateRoot({}, "/home/u")).toBe("/home/u/.local/state/pi-swarm");
});

it("covers every outcome the adoption step can return", () => {
  const doc = svg();
  for (const outcome of ["adopted", "none", "conflict"]) expect(doc).toContain(outcome);
});

it("claims no .swarm destination outside the known legacy or input set", () => {
  // Inputs the repository keeps, and the legacy locations the change removes. Anything
  // else appearing as a `.swarm...` path would be a destination claim this change does
  // not make — remove it from the picture or add it to the code first.
  const allowed = [
    ".swarm",
    ".swarm/",
    ".swarm/AGENTS.md",
    ".swarm/SWARM.md",
    ".swarm/skills/",
    ".swarmpi/execution/*.json",
    ".swarm/claw/{control,supervisor,sessions/*}",
    ".swarm/scheduled_tasks.json",
  ];
  const found = [...new Set(svg().match(/\.swarm(?:pi)?[\w/{}.,*-]*/g) ?? [])];
  // Exact match only: a prefix rule would wave through any new ".swarm/..." claim.
  const stray = found.filter((path) => !allowed.includes(path));
  expect(stray).toEqual([]);
});

it("stays readable to a screen reader", () => {
  const doc = svg();
  expect(doc).toContain('role="img"');
  expect(doc).toMatch(/aria-labelledby="title desc"/);
  expect(doc).toContain('<title id="title">');
  expect(doc).toContain('<desc id="desc">');
  // xml:space is mandatory: SVG collapses runs of spaces, which silently merges columns.
  const strayText = [...doc.matchAll(/<text(?![^>]*xml:space="preserve")/g)].length;
  expect(strayText).toBe(0);
});
