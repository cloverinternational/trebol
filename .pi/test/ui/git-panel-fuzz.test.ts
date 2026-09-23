import { describe, expect, it } from "vitest";
import { gitPanel } from "../../lib/ui/git-panel-layout.ts";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const data = (branch: string, commits: string[]) => ({ cwd: "/workspace", branch, added: 284, removed: 49, commits });

function assertBox(rows: string[], maxWidth: number) {
  expect(rows.length).toBeGreaterThanOrEqual(3);
  const plain = rows.map(stripAnsi);
  const width = plain[0].length;
  expect(width).toBeLessThanOrEqual(maxWidth);
  expect(plain.at(-1)?.length).toBe(width);
  expect(plain[0]?.startsWith("┌")).toBe(true);
  expect(plain[0]?.endsWith("┐")).toBe(true);
  expect(plain.at(-1)?.startsWith("└")).toBe(true);
  expect(plain.at(-1)?.endsWith("┘")).toBe(true);
  for (const row of plain.slice(1, -1)) {
    expect(row.length).toBe(width);
    expect(row.startsWith("│")).toBe(true);
    expect(row.endsWith("│")).toBe(true);
  }
  expect(plain[0].length).toBe(plain.at(-1)?.length);
  expect(plain[0].slice(1, -1).length).toBe(plain[1]?.slice(1, -1).length);
}

describe("Git panel geometry fuzzing", () => {
  it("keeps borders rectangular across widths and hostile content", () => {
    const seeds = ["", "main", "feature/" + "x".repeat(200), "🚀".repeat(40), "\x1b[31mred\x1b[0m"];
    for (let width = 18; width <= 140; width++) {
      for (const branch of seeds) {
        const commits = [branch, `${branch} commit`, "a".repeat(width * 2)];
        assertBox(gitPanel(data(branch, commits), width), width);
      }
    }
  });
});
