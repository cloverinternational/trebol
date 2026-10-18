"""Mine real retrieval events from pi session transcripts + git.
Usage: python3 mine.py  -> raw-events.jsonl (every parsed search event, unfiltered), queries.jsonl (filtered, deduped, split), mine-stats.json.
Raw source: ~/.pi/agent/sessions/--Users-swarm-Work-Clover-trebol--/*.jsonl (read-only)."""
import json, glob, os, re, shlex, subprocess, hashlib, random, collections
REPO = "/Users/swarm/Work/Clover/trebol"; OUT = os.path.dirname(os.path.abspath(__file__))
SESS = os.path.expanduser("~/.pi/agent/sessions/--Users-swarm-Work-Clover-trebol--")
FOLLOW = 6  # tool calls after the search that count as "used next"
tracked = set(subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True).stdout.split())
OPTS_WITH_ARG = {"-g", "--glob", "-t", "--type", "-T", "-m", "--max-count", "-A", "-B", "-C", "--max-depth", "-j", "--include", "--exclude", "--exclude-dir", "-f"}
TUNING_MARK = re.compile(r"h2h|project_context|memory-audit|rag-eval|heldout", re.I)

def text_of(c):
    return c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict) and x.get("type") == "text")

def patterns(cmd):
    out = []
    for seg in re.split(r"\|\||&&|;|\||\n|\$\(|`", cmd):
        try: toks = shlex.split(seg)
        except ValueError: continue
        for i, t in enumerate(toks):
            if t not in ("rg", "grep", "egrep"): continue
            rest, j = toks[i + 1:], 0
            if "--files" in rest: break
            while j < len(rest):
                a = rest[j]
                if a in ("-e", "--regexp") and j + 1 < len(rest): out.append(rest[j + 1]); break
                if a in OPTS_WITH_ARG: j += 2; continue
                if a.startswith("-"): j += 1; continue
                out.append(a); break
            break
    return out

def files_in(name, args):
    s = set()
    if name in ("Bash", "bash"):
        for tok in re.findall(r"[\w./@-]+\.\w+", args.get("command", "")): s.add(tok.lstrip("./"))
    elif name == "apply_patch":
        s |= set(re.findall(r"\*\*\* (?:Update|Add) File: (\S+)", args.get("input", "")))
    elif name in ("Read", "read", "write", "edit"):
        s.add(str(args.get("file_path") or args.get("path") or "").replace(REPO + "/", ""))
    return {p for p in s if p in tracked}

commits = []
log = subprocess.run(["git", "log", "--since=2026-09-01", "--name-only", "--format=@@%H %aI"], cwd=REPO, capture_output=True, text=True).stdout
for block in log.split("@@")[1:]:
    head, *names = block.strip().split("\n"); sha, when = head.split()
    commits.append((sha, when, {n for n in names if n}))

raw, parse_fail = [], 0
for f in sorted(glob.glob(SESS + "/*.jsonl")):
    sid = os.path.basename(f); calls, last_user, tuning = [], "", False
    for ln, l in enumerate(open(f), 1):
        try: e = json.loads(l)
        except Exception: parse_fail += 1; continue
        if e.get("type") != "message": continue
        m = e["message"]
        if m.get("role") == "user":
            t = text_of(m.get("content")).strip()
            if t and not t.startswith("<"): last_user = t[:600]
            continue
        if m.get("role") != "assistant" or not isinstance(m.get("content"), list): continue
        for x in m["content"]:
            if not (isinstance(x, dict) and x.get("type") == "toolCall"): continue
            a = x.get("arguments") or {}
            if TUNING_MARK.search(json.dumps(a)): tuning = True
            calls.append({"name": x.get("name"), "args": a, "ref": f"{sid}#L{ln}", "ts": e.get("timestamp"), "user": last_user})
    edited = set().union(*[files_in(c["name"], c["args"]) for c in calls if c["name"] == "apply_patch"]) if calls else set()
    for i, c in enumerate(calls):
        qs = []
        if c["name"] in ("Bash", "bash"): qs = [("rg", p) for p in patterns(c["args"].get("command", ""))]
        elif c["name"] == "memory_history" and c["args"].get("operation") in ("search", "recall", "ask"):
            qs = [("memory_history", str(c["args"].get("query") or c["args"].get("text") or ""))]
        elif c["name"] == "project_context": qs = [("project_context", str(c["args"].get("query", "")))]
        nxt = set().union(*[files_in(n["name"], n["args"]) for n in calls[i + 1:i + 1 + FOLLOW]]) if i + 1 < len(calls) else set()
        nedit = set().union(*[files_in(n["name"], n["args"]) for n in calls[i + 1:i + 1 + FOLLOW] if n["name"] == "apply_patch"]) if i + 1 < len(calls) else set()
        for kind, q in qs:
            if not q.strip(): continue
            hit = [(s, fs & (nxt | edited)) for s, w, fs in commits if c["ts"] and w[:10] >= c["ts"][:10] and fs & edited]
            raw.append({"session": sid, "source_ref": c["ref"], "ts": c["ts"], "origin": kind, "text": q, "need": c["user"],
                        "tuning_session": tuning, "next_files": sorted(nxt), "next_edited": sorted(nedit),
                        "commit": hit[-1][0] if hit else None, "commit_files": sorted(hit[-1][1]) if hit else []})

with open(f"{OUT}/raw-events.jsonl", "w") as w:
    for r in raw: w.write(json.dumps(r) + "\n")

prior = [q["query"] for q in json.load(open(f"{REPO}/artifacts/memory-audit/h2h-questions.json"))] if False else []
for p in ("h2h-questions.json", "heldout-questions.json"):
    d = json.load(open(f"{REPO}/artifacts/memory-audit/{p}")); d = d if isinstance(d, list) else d.get("questions", d)
    prior += [x["query"] for x in d]
prior += [x["query"] for x in json.load(open(f"{REPO}/artifacts/memory-audit/scan-global.json"))["memory_history"]["queries"]]
toks = lambda s: set(re.findall(r"[a-z0-9_]{3,}", s.lower()))
jac = lambda a, b: len(a & b) / max(1, len(a | b))
SECRET = re.compile(r"(sk-|ghp_|token|password|secret|api[_-]?key)", re.I)

stats = collections.OrderedDict(raw=len(raw), parse_failures=parse_fail)
s1 = [r for r in raw if not r["tuning_session"]]; stats["non_tuning_session"] = len(s1)
s2 = [r for r in s1 if 4 <= len(r["text"]) <= 200 and len(toks(r["text"])) >= 1 and not SECRET.search(r["text"])]; stats["usable_text_no_secret"] = len(s2)
s3 = [r for r in s2 if r["next_files"] or r["commit_files"]]; stats["has_followup_files"] = len(s3)
seen, s4 = [], []
for r in sorted(s3, key=lambda r: r["ts"] or ""):
    t = toks(r["text"])
    if any(jac(t, u) >= 0.8 for u in seen): continue
    seen.append(t); s4.append(r)
stats["deduped_jaccard08"] = len(s4)
s5 = [r for r in s4 if not any(jac(toks(r["text"]), toks(p)) >= 0.5 for p in prior)]; stats["no_overlap_with_tuned_or_heldout"] = len(s5)
sessions = sorted({r["session"] for r in s5}); random.Random(20261018).shuffle(sessions)
test_s = set(sessions[: len(sessions) // 2])
for r in s5:
    r["split"] = "test" if r["session"] in test_s else "dev"
    r["id"] = hashlib.sha256((r["source_ref"] + "\0" + r["text"]).encode()).hexdigest()[:12]
stats["dev"] = sum(r["split"] == "dev" for r in s5); stats["test"] = sum(r["split"] == "test" for r in s5)
stats["sessions_dev"] = len(sessions) - len(test_s); stats["sessions_test"] = len(test_s)
stats["by_origin_test"] = collections.Counter(r["origin"] for r in s5 if r["split"] == "test")
with open(f"{OUT}/queries.jsonl", "w") as w:
    for r in s5: w.write(json.dumps(r) + "\n")
json.dump(stats, open(f"{OUT}/mine-stats.json", "w"), indent=1); print(json.dumps(stats))
