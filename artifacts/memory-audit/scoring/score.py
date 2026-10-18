# Run from artifacts/memory-audit: .venv/bin/python scoring/score.py
# Score sealed runs once against sealed qrels (ranx) + paired bootstrap. Usage: score.py > scores.txt
import json, os, numpy as np, warnings; warnings.filterwarnings("ignore")
from ranx import Qrels, Run, evaluate
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval"))  # sealed inputs; eval/select.py shadows stdlib select, so the script lives outside it
qrels = {}
for l in open("qrels.jsonl"):
    x = json.loads(l); qrels.setdefault(x["qid"], {})[x["doc"]] = x["grade"]
judged = {q for q in qrels}
rel = {q: {d: g for d, g in v.items() if g > 0} for q, v in qrels.items()}
eval_q = sorted(q for q in rel if rel[q])
excl = sorted(set(json.loads(l)["qid"] for l in open("test-queries.jsonl")) - set(eval_q))
runs = {}
for l in open("runs.jsonl"):
    x = json.loads(l)
    for arm, lst in x["runs"].items(): runs.setdefault(arm, {})[x["qid"]] = lst[:10]
for l in open("memory-run.jsonl"):
    x = json.loads(l); runs.setdefault("memory", {})[x["qid"]] = [i["doc"] for i in x["run"]][:10]
Q = Qrels({q: rel[q] for q in eval_q})
M = ["ndcg@10", "mrr@10", "recall@10"]
per = {}
print(f"eval queries {len(eval_q)}; excluded (no rel>=1 in pool) {len(excl)}: {excl}")
print(f"{'arm':10} " + " ".join(f"{m:>10}" for m in M) + "  any@10")
for arm in ["rg", "memory", "dense_v1", "rrf_v1", "dense_v2", "bm25_v2", "rrf_v2"]:
    r = {q: ({d: 1.0 / (i + 1) for i, d in enumerate(runs[arm].get(q, []))} or {"__none__": 0.0}) for q in eval_q}
    res = evaluate(Q, Run(r), M, return_mean=False)
    per[arm] = {m: np.asarray(res[m]) for m in M}
    hit = np.mean([any(d in rel[q] for d in runs[arm].get(q, [])) for q in eval_q])
    print(f"{arm:10} " + " ".join(f"{per[arm][m].mean():10.3f}" for m in M) + f"  {hit:6.3f}")
rng = np.random.default_rng(20261018); B = 10000; n = len(eval_q)
idx = rng.integers(0, n, size=(B, n))
def boot(a, b, m="ndcg@10"):
    d = per[a][m] - per[b][m]; s = d[idx].mean(1); lo, hi = np.percentile(s, [2.5, 97.5])
    v = "not established" if lo <= 0 <= hi else ("better" if lo > 0 and abs(d.mean()) >= 0.05 else ("worse" if hi < 0 and abs(d.mean()) >= 0.05 else "detectable, below MMD"))
    if hi < 0 and v == "better": v = "worse"
    return f"{a} - {b}: delta {d.mean():+.3f}  95% CI [{lo:+.3f}, {hi:+.3f}]  -> {v}"
print("\nPaired bootstrap, nDCG@10, B=10000, seed 20261018, MMD 0.05")
best = max(["dense_v2", "bm25_v2", "rrf_v2"], key=lambda a: per[a]["ndcg@10"].mean())
for a, b in [("rrf_v2", "dense_v2"), ("rrf_v2", "rrf_v1"), ("dense_v2", "dense_v1"), (best, "rg"), (best, "memory"), ("rrf_v2", "bm25_v2")]:
    print(boot(a, b))
print(f"(best v2 arm by mean nDCG@10: {best})")
json.dump({a: {m: per[a][m].tolist() for m in M} for a in per} | {"_queries": eval_q}, open("per-query-scores.json", "w"))
