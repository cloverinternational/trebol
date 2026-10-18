"""Mine retrieval qrels for project memory from real sessions (no retriever involved).
Query  = (a) "user": a real user request (runtime-injected text excluded), or
         (b) "agent": a memory_history search/recall/ask query an agent issued;
         its files are those touched after the search until the next user request.
Gold   = memory records created BEFORE that request, in a DIFFERENT session, whose
         files (evidence paths + tracked paths named in the text) intersect the files
         the agent then EDITED (grade 2) or only READ (grade 1) for that request.
Files touched by >15% of requests (e.g. AGENTS.md) are ignored as non-discriminative.
Only kind=fact records naming 1-6 tracked files can be gold (task snapshots list
many files and are kept in the corpus as distractors only).
Usage: python3 tools/bench/mine-retrieval-qrels.py RECORDS.jsonl OUT.json"""
import json, os, re, sys, glob, subprocess, collections
REPO = "/Users/swarm/Work/Clover/trebol"
SESS = os.path.expanduser("~/.pi/agent/sessions/--Users-swarm-Work-Clover-trebol--")
tracked = set(subprocess.check_output(["git", "-C", REPO, "ls-files"], text=True).split())
PATH = re.compile(r"(?:/Users/swarm/Work/Clover/trebol/)?((?:\.pi|extensions|packages|prompts|tools|docs|tests|infra)/[\w./@-]+\.\w+|AGENTS\.md|package\.json)")
INJECT = ("<system-reminder", "[SCHEDULED]", "## MCP Context", "## Current Tasks", "**Current Mode**", "[ANNOYANCE", "The conversation history before this point")
def paths(s): return {m.group(1) for m in PATH.finditer(s or "") if m.group(1) in tracked}
def sid(f): return os.path.basename(f).split("_")[-1].split(".")[0]
reqs = []
for f in sorted(glob.glob(SESS + "/*.jsonl")):
    if os.path.getsize(f) > 400e6: continue
    cur = None
    for line in open(f, errors="ignore"):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") != "message": continue
        m = e["message"]
        if m["role"] == "user":
            t = m["content"] if isinstance(m["content"], str) else "".join(p.get("text", "") for p in m["content"] if p.get("type") == "text")
            if not t.strip() or t.lstrip().startswith(INJECT): continue
            cur = {"session": sid(f), "ts": e["timestamp"], "text": t.strip()[:1500], "edit": set(), "read": set(), "kind": "user"}; reqs.append(cur)
        elif m["role"] == "assistant" and cur:
            for p in m["content"]:
                if p.get("type") != "toolCall": continue
                a = p.get("arguments") or {}; n = p["name"]; s = json.dumps(a)
                if n == "memory_history" and a.get("operation") in ("search", "recall", "ask") and str(a.get("query") or "").strip():
                    cur = {"session": sid(f), "ts": e["timestamp"], "text": str(a["query"]).strip()[:500], "edit": set(), "read": set(), "kind": "agent", "parent": cur}; reqs.append(cur); continue
                for c in (cur, cur.get("parent")) if cur.get("kind") == "agent" else (cur,):
                    if not c: continue
                    if n in ("apply_patch", "edit", "write", "Write", "Edit"): c["edit"] |= paths(s)
                    else: c["read"] |= paths(s)
records = [json.loads(l) for l in open(sys.argv[1])]
def rec_files(r):
    s = r["text"] + " " + " ".join(x.get("ref", "") for x in r.get("evidence") or [])
    return paths(s)
def rec_session(r):
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", r.get("source") or "")
    return m.group(1) if m else ""
for r in records: r["_files"] = rec_files(r); r["_session"] = rec_session(r)
freq = collections.Counter(p for q in reqs if q["kind"] == "user" for p in q["edit"] | q["read"])
common = {p for p, c in freq.items() if c > 0.15 * sum(q["kind"] == "user" for q in reqs)}
out = []
for i, q in enumerate(reqs):
    edit, read = q["edit"] - common, (q["read"] - q["edit"]) - common
    if not edit and not read: continue
    gold = {}
    for r in records:
        if r["kind"] != "fact" or not 1 <= len(r["_files"]) <= 6: continue
        if r["createdAt"] >= q["ts"] or r["_session"] == q["session"]: continue
        if r["_files"] & edit: gold[r["id"]] = 2
        elif r["_files"] & read: gold[r["id"]] = 1
    if any(g == 2 for g in gold.values()):
        out.append({"qid": f"{q['kind'][0].upper()}{i:04d}", "kind": q["kind"], "session": q["session"], "ts": q["ts"], "text": q["text"], "edit": sorted(edit), "read": sorted(read), "gold": gold})
json.dump({"requests_total": len(reqs), "common_files": sorted(common), "queries": out}, open(sys.argv[2], "w"), indent=1)
print("requests", collections.Counter(q["kind"] for q in reqs), "with gold", collections.Counter(q["kind"] for q in out), "common", sorted(common))
print("gold per query p50", sorted(len(q["gold"]) for q in out)[len(out)//2] if out else 0)
