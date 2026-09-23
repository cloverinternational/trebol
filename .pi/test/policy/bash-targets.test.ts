import { describe, expect, it } from "vitest";
import { bashCreationTargets } from "../../lib/policy/bash-targets.ts";

describe("bash creation targets", () => {
  it("detects the direct file-creating commands", () => {
    expect(bashCreationTargets("touch junk.md")).toEqual(["junk.md"]);
    expect(bashCreationTargets("mkdir scratch")).toEqual(["scratch"]);
    expect(bashCreationTargets("mkdir -p src/deep/nested")).toEqual(["src/deep/nested"]);
    expect(bashCreationTargets("touch a.md b.md")).toEqual(["a.md", "b.md"]);
  });

  it("detects redirects, which are the most common way to create a file", () => {
    expect(bashCreationTargets("echo hi > junk.md")).toEqual(["junk.md"]);
    expect(bashCreationTargets("echo hi >> junk.md")).toEqual(["junk.md"]);
    expect(bashCreationTargets("printf x>out.txt")).toEqual(["out.txt"]);
    expect(bashCreationTargets("cat README.md > copy.md")).toEqual(["copy.md"]);
  });

  it("detects the destination of single-source copies and moves", () => {
    expect(bashCreationTargets("cp README.md junk.md")).toEqual(["junk.md"]);
    expect(bashCreationTargets("mv old.md new.md")).toEqual(["new.md"]);
  });

  it("checks every command in a compound line", () => {
    expect(bashCreationTargets("mkdir scratch && touch scratch/x.md")).toEqual(["scratch", "scratch/x.md"]);
    expect(bashCreationTargets("cd src; touch a.md")).toEqual([]);
  });

  it("ignores read-only commands so the guard stays usable", () => {
    for (const command of [
      "ls -la",
      "cat README.md",
      "grep -rn TODO src/",
      "git status --porcelain",
      "npx vitest run",
      "rm -rf build",
      "echo hello",
      "node -e \"console.log(1)\"",
    ]) expect(bashCreationTargets(command)).toEqual([]);
  });

  it("claims nothing when the command cannot be read literally", () => {
    // Guessing here would block legitimate work, so these must stay allowed.
    expect(bashCreationTargets("touch $FILE")).toEqual([]);
    expect(bashCreationTargets("touch $(mktemp)")).toEqual([]);
    expect(bashCreationTargets("touch `date +%s`.md")).toEqual([]);
    expect(bashCreationTargets("cat <<'EOF' > out.md\nbody\nEOF")).toEqual([]);
    expect(bashCreationTargets("touch build/*.tmp")).toEqual([]);
    expect(bashCreationTargets("cd /tmp && touch junk.md")).toEqual([]);
    expect(bashCreationTargets("touch 'unbalanced")).toEqual([]);
  });

  it("does not mistake redirect-like text inside quotes for a redirect", () => {
    expect(bashCreationTargets("echo 'a > b'")).toEqual([]);
    expect(bashCreationTargets("git commit -m \"fix > bug\"")).toEqual([]);
  });

  it("ignores shell special destinations", () => {
    expect(bashCreationTargets("command > /dev/null")).toEqual([]);
    expect(bashCreationTargets("command 2>&1")).toEqual([]);
  });

  it("does not claim multi-source copies, whose targets live inside the destination", () => {
    expect(bashCreationTargets("cp a.md b.md docs/")).toEqual([]);
  });
});
