"""Run every retrieval arm on the sealed test queries. Runs on spark (corpus, DBs, embedding server).
Usage: ~/Agent-MCP/.venv/bin/python arms.py test-queries.jsonl > runs.jsonl
Canonical retrieval unit = a v2 chunk (corpus-v2 DB chunk_id), located to a line range in the corpus file.
Arms (top 10 each, no tuning on test):
  dense_v1 / rrf_v1  : markdown-only DB (v1); hits mapped to the identical v2 chunk when (ref,text) match.
  dense_v2 / bm25_v2 / rrf_v2 : markdown+code DB (v2). RRF k=60 over dense@100 and bm25@100 (same as deployed query.py).
  rg      : the searcher's own pattern, BRE escapes converted, `rg -n -i` over corpus-v2; files ranked by match count,
            each match line mapped to its v2 chunk; first 10 unique chunks.
Query text for dense/bm25 = pattern with regex metacharacters mechanically replaced by spaces."""
import sqlite3, sqlite_vec, json, re, os, sys, subprocess, urllib.request, collections
H = os.path.expanduser; CORP = H("~/trebol-corpus-v2")
def opendb(p):
    d = sqlite3.connect(p); d.enable_load_extension(True); sqlite_vec.load(d); return d
v1, v2 = opendb(H("~/trebol-corpus/.agent/mcp_state.db")), opendb(H("~/trebol-corpus-v2/.agent/mcp_state.db"))
def load(db): return {c: (r, t, md) for c, r, t, md in db.execute("select chunk_id, source_ref, chunk_text, metadata from rag_chunks")}
C1, C2 = load(v1), load(v2)
by_text = {(r, t): c for c, (r, t, _) in C2.items()}
def is_summary(md): return '"document_type": "file_summary"' in (md or "")
# locate v2 chunks to line ranges
span = {}; per_file = collections.defaultdict(list)
for c, (r, t, md) in C2.items():
    if is_summary(md) or r.startswith("context"): continue
    try: lines = open(os.path.join(CORP, r), errors="replace").read().split("\n")
    except OSError: continue
    probe = [l.strip() for l in t.split("\n") if len(l.strip()) >= 12]
    if not probe: continue
    s = next((i for i, l in enumerate(lines) if probe[0] in l and (len(probe) < 2 or any(probe[1] in n for n in lines[i + 1:i + 6]))), None)
    if s is None: continue
    e = next((i for i in range(s, min(len(lines), s + 400)) if probe[-1] in lines[i]), s)
    span[c] = (r, s + 1, e + 1); per_file[r].append((s + 1, e + 1, c))
mems = []
for name, db, C in (("v1", v1, C1), ("v2", v2, C2)):
    m = sqlite3.connect(":memory:"); m.execute('create virtual table f using fts5(t, tokenize="porter unicode61 tokenchars _")')
    m.executemany("insert into f(rowid,t) values(?,?)", [(c, r + "\n" + t) for c, (r, t, _) in C.items()]); mems.append(m)
def emb(t):
    r = urllib.request.Request("http://127.0.0.1:8200/v1/embeddings", json.dumps({"model": "embeddinggemma-2:query", "input": [t]}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r))["data"][0]["embedding"]
def dense(db, q, k): return [r[0] for r in db.execute("select rowid from rag_embeddings where embedding match ? and k = ? order by distance", (json.dumps(emb(q)), k))]
def bm25(m, q, k):
    terms = [w for w in re.findall(r"[A-Za-z0-9_]+", q) if len(w) > 1]
    return [r[0] for r in m.execute("select rowid from f where f match ? order by bm25(f) limit ?", (" OR ".join(f'"{w}"' for w in terms), k))] if terms else []
def rrf(a, b, k=60):
    s = {}
    for l in (a, b):
        for i, c in enumerate(l): s[c] = s.get(c, 0) + 1 / (k + i + 1)
    return sorted(s, key=s.get, reverse=True)
def norm(t): return re.sub(r"\s+", " ", re.sub(r"\\[|(){}bwsdBWSD]|[|^$*+?()\[\]{}\\]|\.\*|\.\{\d*,?\d*\}", " ", t)).strip()
def to_rust(p): return p.replace("\\|", "|").replace("\\(", "(").replace("\\)", ")").replace("\\{", "{").replace("\\}", "}")
def canon1(c):  # v1 chunk -> v2 chunk id if identical text, else namespaced v1 id
    r, t, _ = C1[c]; return str(by_text[(r, t)]) if (r, t) in by_text else f"v1:{c}"
def chunk_at(ref, line):
    best = [c for s, e, c in per_file.get(ref, []) if s <= line <= e]
    return min(best, key=lambda c: span[c][2] - span[c][1]) if best else None
def rg(p):
    args = ["rg", "-n", "-i", "--no-heading", "--glob", "!.agent", "-e", to_rust(p), "."]
    out = subprocess.run(args, cwd=CORP, capture_output=True, text=True, timeout=60)
    if out.returncode == 2: out = subprocess.run(["rg", "-n", "-i", "-F", "--no-heading", "--glob", "!.agent", "-e", p, "."], cwd=CORP, capture_output=True, text=True, timeout=60)
    hits = collections.defaultdict(list)
    for l in out.stdout.splitlines():
        m = re.match(r"\./(.+?):(\d+):", l)
        if m: hits[m.group(1)].append(int(m.group(2)))
    res = []
    for f in sorted(hits, key=lambda f: (-len(hits[f]), f)):
        for ln in hits[f]:
            c = chunk_at(f, ln)
            key = str(c) if c else f"file:{f}#L{ln}"
            if key not in res: res.append(key)
            if c: break  # one chunk per file in the first pass
        if len(res) >= 10: break
    return res[:10], sum(map(len, hits.values()))
def passage(doc):
    if doc.startswith("v1:"):
        r, t, _ = C1[int(doc[3:])]; return {"ref": r, "lines": None, "text": t}
    if doc.startswith("file:"):
        f, ln = doc[5:].rsplit("#L", 1); ln = int(ln); L = open(os.path.join(CORP, f), errors="replace").read().split("\n")
        return {"ref": f, "lines": [max(1, ln - 10), min(len(L), ln + 10)], "text": "\n".join(L[max(0, ln - 11):ln + 10])}
    c = int(doc); r, t, md = C2[c]; sp = span.get(c)
    return {"ref": r, "lines": [sp[1], sp[2]] if sp else None, "text": t, "summary": is_summary(md)}
if sys.argv[1] == "passages":
    docs = sorted({d for l in open(sys.argv[2]) for v in json.loads(l)["runs"].values() for d in v})
    for d in docs: print(json.dumps({"doc": d, **passage(d)}))
    sys.exit(0)
if True:
    for l in open(sys.argv[1]):
        q = json.loads(l); t = norm(q["text"]) or q["text"]
        d1, d2 = dense(v1, t, 100), dense(v2, t, 100); b1, b2 = bm25(mems[0], t, 100), bm25(mems[1], t, 100)
        rgr, nmatch = rg(q["text"])  # memory_history queries: the phrase as a regex (no real rg pattern exists)
        runs = {"dense_v1": [canon1(c) for c in d1[:10]], "rrf_v1": [canon1(c) for c in rrf(d1, b1)[:10]],
                "dense_v2": [str(c) for c in d2[:10]], "bm25_v2": [str(c) for c in b2[:10]], "rrf_v2": [str(c) for c in rrf(d2, b2)[:10]], "rg": rgr}
        print(json.dumps({"qid": q["qid"], "query_norm": t, "rg_matches": nmatch, "runs": runs}), flush=True)
