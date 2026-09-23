import { describe, expect, it } from "vitest";
import { chooseCloverVariant, cloverRows, VIEWPORT_MATRIX } from "../../lib/ui/clover-layout.ts";

const data = { branch: "main", added: 3, removed: 1, commits: ["abc123  first", "def456  second", "ghi789  third"] };
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("responsive clover startup header", () => {
  it.each(VIEWPORT_MATRIX)("fits %dx%d without horizontal overflow", (width, height) => {
    const rendered = cloverRows(width, height);
    expect(rendered.length).toBeLessThanOrEqual(height);
    expect(Math.max(...rendered.map((row) => plain(row).length))).toBeLessThanOrEqual(width);
  });

  it("uses full, medium, then tiny art as the viewport shrinks", () => {
    expect(chooseCloverVariant(120, 40)).toBe("full");
    expect(chooseCloverVariant(72, 24)).toBe("medium");
    expect(chooseCloverVariant(40, 10)).toBe("tiny");
  });
});
