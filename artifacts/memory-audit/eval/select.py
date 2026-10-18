"""Pre-registered, mechanical selection of the sealed test queries from queries.jsonl (split=test).
Rule (fixed before any arm ran): 5<=len<=120; >=1 token [A-Za-z0-9_]{4,}; no minified-bundle scraping (\{ or .{N});
next_files or commit_files must contain a non-vendor file other than package.json. Stratified by query form,
seed 20261018: 22 identifier, 10 phrase, 8 regex/alternation, plus every memory_history query in test."""
import json, re, random, hashlib, os
D = os.path.dirname(os.path.abspath(__file__))
q = [json.loads(l) for l in open(f"{D}/queries.jsonl")]
def form(r):
    t = r["text"].strip()
    if r["origin"] != "rg": return r["origin"]
    if re.fullmatch(r"[\w.-]+", t): return "identifier"
    if " " in t and not re.search(r"[\\|()\[\]^$*+?]", t): return "phrase"
    return "regex"
def ok(r):
    t = r["text"]
    useful = [f for f in r["next_files"] + r["commit_files"] if not f.startswith("vendor/") and f != "package.json"]
    return 5 <= len(t) <= 120 and re.search(r"[A-Za-z0-9_]{4,}", t) and not re.search(r"\\\{|\.\{\d", t) and useful
pool = [r for r in q if r["split"] == "test" and ok(r)]
rng = random.Random(20261018); out = []
for f, n in (("identifier", 22), ("phrase", 10), ("regex", 8), ("memory_history", 99)):
    xs = sorted([r for r in pool if form(r) == f], key=lambda r: r["id"]); rng.shuffle(xs)
    out += [dict(r, form=f) for r in xs[:n]]
for i, r in enumerate(out): r["qid"] = f"T{i+1:02d}"
with open(f"{D}/test-queries.jsonl", "w") as w:
    for r in out: w.write(json.dumps({k: r[k] for k in ("qid", "id", "form", "origin", "text", "need", "source_ref", "session", "ts", "next_files", "next_edited", "commit", "commit_files")}) + "\n")
print("eligible", len(pool), "selected", len(out), {f: sum(r["form"] == f for r in out) for f in ("identifier", "phrase", "regex", "memory_history")})
