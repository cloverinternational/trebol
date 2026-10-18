#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi sessions + Tern bridge: the startup card's git status overlay lists every fixture state exactly as git reports it,
 *  file clicks open diffs, the card refreshes from watchers, and reads never write .git/index or leave index.lock. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const ESC = "\u001b";
const root = mkdtempSync(join(tmpdir(), "trebol-tern-startup-"));
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const agentDir = join(root, "agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 8000, maxTokens: 1000 }] } } }));
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
const commit = (cwd, message) => git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", message);
const write = (cwd, rel, text) => writeFileSync(join(cwd, rel), text);
const gitDirOf = (cwd) => git(cwd, "rev-parse", "--absolute-git-dir").trim();

// Git is the oracle: the expected rows come from `git status --porcelain=v2 -z`, parsed here by the test, not by the card.
function expectedRows(cwd) {
  const out = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], { cwd }).toString();
  const tokens = out.split("\0");
  const rows = [];
  const pathAfter = (t, spaces) => { let at = -1; for (let k = 0; k < spaces; k++) at = t.indexOf(" ", at + 1); return t.slice(at + 1); };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("1 ") || t.startsWith("2 ")) {
      const [x, y] = t.split(" ")[1];
      const path = pathAfter(t, t.startsWith("1 ") ? 8 : 9);
      if (t.startsWith("2 ")) i++;
      if (x !== ".") rows.push(`staged|${path}|${x}`);
      if (y !== ".") rows.push(`unstaged|${path}|${y}`);
    } else if (t.startsWith("u ")) {
      const xy = t.split(" ")[1];
      rows.push(`conflicts|${pathAfter(t, 10)}|${xy}`);
    } else if (t.startsWith("? ")) {
      rows.push(`untracked|${t.slice(2)}|??`);
    }
  }
  return rows.sort();
}

async function openCard(cwd) {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
  const writes = [];
  const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  const frames = () => writes.join("").split(ESC).filter((part) => part.startsWith("_tsp;"));
  const replay = () => {
    const nodes = new Map();
    const drop = (id) => { for (const [child, e] of nodes) if (e.parent === id) drop(child); nodes.delete(id); };
    const put = (parent, node) => { nodes.set(node.id, { parent, node }); for (const c of node.c ?? []) put(node.id, c); };
    for (const f of frames().filter((x) => x.startsWith("_tsp;f;"))) {
      const body = JSON.parse(f.slice("_tsp;f;".length).split(`${ESC}\\`)[0]);
      for (const op of body.ops) {
        if (op[0] === "add") put(op[2], op[4]);
        else if (op[0] === "set" && nodes.has(op[1])) Object.assign(nodes.get(op[1]).node.p, op[2]);
        else if (op[0] === "text" && nodes.has(op[1]) && op[2] === "append") nodes.get(op[1]).node.p.text += op[3];
        else if (op[0] === "del") drop(op[1]);
      }
    }
    return nodes;
  };
  const waitFor = async (check, ms = 12_000) => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return check();
  };
  const click = (id, act, value) => bridge.handle({ verb: "e", body: { ev: "action", id, act, ...(value !== undefined ? { value } : {}) } });
  const key = (k) => bridge.handle({ verb: "e", body: { ev: "key", key: k } });
  const overlayFiles = (nodes) => [...nodes.keys()].filter((id) => /^git-file-\d+$/.test(id)).map((id) => {
    const section = nodes.get(id).parent.replace(/^git-section-/, "");
    return `${section}|${nodes.get(`${id}-path`).node.p.spans[0].t}|${nodes.get(`${id}-code`).node.p.spans[0].t}`;
  }).sort();
  return { bridge, replay, waitFor, click, key, overlayFiles, dispose: () => { bridge.close(); session.dispose(); } };
}

const fixtures = {
  clean(dir) { write(dir, "a.txt", "a\n"); git(dir, "add", "a.txt"); commit(dir, "one"); },
  staged(dir) { write(dir, "a.txt", "a\n"); git(dir, "add", "a.txt"); commit(dir, "one"); write(dir, "b.txt", "MARK-staged\n"); git(dir, "add", "b.txt"); },
  unstaged(dir) { write(dir, "a.txt", "a\n"); git(dir, "add", "a.txt"); commit(dir, "one"); write(dir, "a.txt", "a\nMARK-unstaged\n"); },
  untracked(dir) { write(dir, "a.txt", "a\n"); git(dir, "add", "a.txt"); commit(dir, "one"); write(dir, "new.txt", "MARK-untracked\n"); },
  rename(dir) { write(dir, "old.txt", "line one\nline two\nline three\nline four\n"); git(dir, "add", "old.txt"); commit(dir, "one"); git(dir, "mv", "old.txt", "new.txt"); },
  conflict(dir) {
    write(dir, "f.txt", "base\n"); git(dir, "add", "f.txt"); commit(dir, "base");
    git(dir, "checkout", "-q", "-b", "side"); write(dir, "f.txt", "side\n"); git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-am", "side");
    git(dir, "checkout", "-q", "main"); write(dir, "f.txt", "main\n"); git(dir, "add", "f.txt"); commit(dir, "main");
    try { git(dir, "merge", "side"); } catch { /* conflict is the fixture */ }
  },
  unicode(dir) { write(dir, "café ünïcode 文件.txt", "one\n"); git(dir, "add", "café ünïcode 文件.txt"); commit(dir, "one"); write(dir, "café ünïcode 文件.txt", "one\nMARK-unicode\n"); write(dir, "with space.md", "MARK-space\n"); },
  detached(dir) { write(dir, "a.txt", "a\n"); git(dir, "add", "a.txt"); commit(dir, "one"); write(dir, "a.txt", "a2\n"); git(dir, "add", "a.txt"); commit(dir, "two"); git(dir, "checkout", "-q", "--detach", "HEAD~1"); write(dir, "a.txt", "a\nMARK-detached\n"); },
  "no-commits"(dir) { write(dir, "first.txt", "first\n"); git(dir, "add", "first.txt"); write(dir, "loose.txt", "loose\n"); },
};

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
};
const deadline = setTimeout(() => { console.error("FAIL tern startup card timed out"); process.exit(1); }, 420_000);

try {
  // One real session per git state: the view's rows must equal git's rows, and each file's click must open its diff.
  for (const [state, setup] of Object.entries(fixtures)) {
    const dir = join(root, state);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    setup(dir);
    const card = await openCard(dir);
    await check(`${state}: card shows the branch and state badge`, async () => {
      assert.ok(await card.waitFor(() => card.replay().get("tern-startup-state")), "state badge rendered");
      assert.equal(card.replay().get("tern-startup-state").node.p.actions.click, "git.open", "badge opens the status view");
    });
    await check(`${state}: status view lists exactly git's changed, staged, unstaged, untracked and conflicted files`, async () => {
      card.click("tern-startup-state", "git.open");
      assert.ok(await card.waitFor(() => card.replay().get("git-status")), "status overlay opened");
      const want = expectedRows(dir);
      const got = card.overlayFiles(card.replay());
      assert.deepEqual(got, want, `rows for ${state}`);
      card.click("git-status", "git.close");
      assert.ok(await card.waitFor(() => !card.replay().get("git-status")), "close action removes the overlay");
    });
    await check(`${state}: each file's click opens its diff`, async () => {
      card.click("tern-startup-state", "git.open");
      assert.ok(await card.waitFor(() => card.replay().get("git-status")));
      const rows = card.overlayFiles(card.replay());
      const nodes = card.replay();
      const ids = [...nodes.keys()].filter((id) => /^git-file-\d+$/.test(id));
      for (const id of ids) {
        card.click(id, "git.file", id.replace("git-file-", ""));
        assert.ok(await card.waitFor(() => card.replay().get("git-diff")?.node.p.text), `diff loaded for ${id}`);
        const diff = card.replay().get("git-diff").node;
        assert.equal(diff.k, "diff");
        assert.ok(diff.p.text.length > 0, `non-empty diff for ${id}`);
        assert.ok(!diff.p.text.startsWith("Diff unavailable"), `git produced a diff for ${id}`);
        card.click("git-back", "git.back");
        assert.ok(await card.waitFor(() => !card.replay().get("git-diff") && card.replay().get("git-status")), "back returns to the list");
      }
      assert.ok(rows.length === ids.length, "every listed file is clickable");
    });
    await check(`${state}: escape returns from a diff, then closes the overlay`, async () => {
      card.click("tern-startup-state", "git.open");
      assert.ok(await card.waitFor(() => card.replay().get("git-status")));
      const first = card.replay().get("git-file-0");
      if (first) {
        card.click("git-file-0", "git.file", "0");
        assert.ok(await card.waitFor(() => card.replay().get("git-diff")));
        card.key("escape");
        assert.ok(await card.waitFor(() => !card.replay().get("git-diff") && card.replay().get("git-status")), "escape from diff goes to the list");
      }
      card.key("escape");
      assert.ok(await card.waitFor(() => !card.replay().get("git-status")), "escape from the list closes");
    });
    card.dispose();
  }

  // Mixed repo: watcher-driven refresh, diff content, and no writes to .git/index or index.lock from reads.
  const live = join(root, "live");
  mkdirSync(live);
  git(live, "init", "-q", "-b", "main");
  write(live, "a.txt", "a\n"); git(live, "add", "a.txt"); commit(live, "one");
  const gd = gitDirOf(live);
  const card = await openCard(live);
  const indexHash = () => createHash("sha256").update(readFileSync(join(gd, "index"))).digest("hex");
  await check("watcher: a new untracked file updates the badge with no manual call", async () => {
    assert.ok(await card.waitFor(() => card.replay().get("tern-startup-state")?.node.p.text === "clean"));
    write(live, "fresh.txt", "MARK-fresh\n");
    assert.ok(await card.waitFor(() => card.replay().get("tern-startup-state")?.node.p.text === "1 untracked", 8_000), "badge follows the worktree");
  });
  await check("watcher: staging a file moves it to the staged section after git add", async () => {
    git(live, "add", "fresh.txt");
    assert.ok(await card.waitFor(() => card.replay().get("tern-startup-state")?.node.p.text === "1 changed", 8_000), "badge follows the index");
    card.click("tern-startup-state", "git.open");
    assert.ok(await card.waitFor(() => card.replay().get("git-status")));
    assert.deepEqual(card.overlayFiles(card.replay()), expectedRows(live));
    card.click("git-status", "git.close");
  });
  await check("reads never write .git/index or leave index.lock", async () => {
    const before = indexHash();
    for (let i = 0; i < 3; i++) {
      card.click("tern-startup-state", "git.open");
      await card.waitFor(() => card.replay().get("git-status"));
      card.click("git-file-0", "git.file", "0");
      await card.waitFor(() => card.replay().get("git-diff"));
      card.click("git-back", "git.back");
      card.key("escape");
      await card.waitFor(() => !card.replay().get("git-status"));
    }
    assert.equal(indexHash(), before, ".git/index bytes unchanged by reads");
    assert.ok(!existsSync(join(gd, "index.lock")), "no index.lock after refresh");
    assert.ok(!readdirSync(gd).some((name) => name.endsWith(".lock")), "no lock files in the git directory");
  });
  card.dispose();

  console.log(results.join("\n"));
  if (results.some((line) => line.startsWith("FAIL"))) process.exitCode = 1;
} catch (error) {
  console.error(`FAIL tern startup card: ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  rmSync(root, { recursive: true, force: true });
}
