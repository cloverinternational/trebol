# Does "chunk text matches the query pattern" (regex proxy) agree with sealed qrels? Run from artifacts/memory-audit.
import json, re, os, math
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval"))
Q = {json.loads(l)["qid"]: json.loads(l)["text"] for l in open("test-queries.jsonl")}
T = {}
for l in open("passages.jsonl"): x = json.loads(l); T[x["doc"]] = x["text"]
for l in open("memory-run.jsonl"):
    for i in json.loads(l)["run"]: T[i["doc"]] = i["text"]
def pat(q):
    q = q.replace("\\|", "|").replace("\\(", "(").replace("\\)", ")")
    try: return re.compile(q, re.I | re.M)
    except re.error: return re.compile(re.escape(q), re.I)
qr = [json.loads(l) for l in open("qrels.jsonl")]
tp = fp = fn = tn = 0; miss_text = 0
for x in qr:
    t = T.get(x["doc"])
    if t is None: miss_text += 1; continue
    p = bool(pat(Q[x["qid"]]).search(t)); r = x["grade"] >= 1
    tp += p and r; fp += p and not r; fn += (not p) and r; tn += (not p) and not r
n = tp + fp + fn + tn
phi = (tp * tn - fp * fn) / math.sqrt((tp + fp) * (fn + tn) * (tp + fn) * (fp + tn))
print(f"items {n} (no text {miss_text}); proxy+ {tp+fp}; qrels rel>=1 {tp+fn}")
print(f"precision {tp/(tp+fp):.3f} ({tp}/{tp+fp})  recall {tp/(tp+fn):.3f} ({tp}/{tp+fn})  phi {phi:.3f}")
# arm level: mean proxy hit@10 vs nDCG@10 ranking
runs = {}
for l in open("runs.jsonl"):
    x = json.loads(l)
    for a, lst in x["runs"].items(): runs.setdefault(a, {})[x["qid"]] = lst[:10]
for l in open("memory-run.jsonl"):
    x = json.loads(l); runs.setdefault("memory", {})[x["qid"]] = [i["doc"] for i in x["run"]][:10]
S = json.load(open("per-query-scores.json")); qs = S["_queries"]
prox = {a: sum(any(pat(Q[q]).search(T.get(d, "")) for d in runs[a].get(q, [])) for q in qs) / len(qs) for a in runs}
nd = {a: sum(S[a]["ndcg@10"]) / len(qs) for a in runs}
ra = sorted(runs, key=lambda a: -prox[a]); rb = sorted(runs, key=lambda a: -nd[a])
k = len(runs); rho = 1 - 6 * sum((ra.index(a) - rb.index(a)) ** 2 for a in runs) / (k * (k * k - 1))
for a in rb: print(f"{a:10} proxy-hit@10 {prox[a]:.3f}  nDCG@10 {nd[a]:.3f}")
print(f"Spearman rho over {k} arms (proxy vs nDCG ranking): {rho:.3f}")
