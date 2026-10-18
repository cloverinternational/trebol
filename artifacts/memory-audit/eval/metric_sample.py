# Step 2: sample regex-gold verdicts on rrf_v2 top-5 (dev+heldout) for manual validity check.
import json, re, random, sys
src = open("arms.py").read().split('\nif sys.argv[1] == "passages":')[0]; exec(src)
rows = []
for f in ("dev.jsonl", "heldout.jsonl"):
    for l in open(f):
        x = json.loads(l)
        if not x.get("gold"): continue
        g = re.compile(x["gold"], re.I); q = x["query"]
        top = [c for c in rrf(dense(v2, q, 100), bm25(mems[1], q, 100)) if not is_summary(C2[c][2])][:5]
        for rank, c in enumerate(top, 1):
            r, t, _ = C2[c]
            rows.append({"set": f, "q": x["q"], "query": q, "gold": x["gold"], "rank": rank, "chunk": c, "ref": r, "hit": bool(g.search(t)), "text": t[:1500]})
rng = random.Random(20261018)
hits = [r for r in rows if r["hit"]]; miss = [r for r in rows if not r["hit"]]
s = rng.sample(hits, min(10, len(hits))) + rng.sample(miss, 10)
rng.shuffle(s)
json.dump(s, open("metric-sample.json", "w"), indent=1)
print(len(rows), len(hits), len(miss), len(s))
