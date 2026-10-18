import json, hashlib, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval"))
P = {}
for l in open("passages.jsonl"):
    x = json.loads(l)
    if x.get("lines") and not x.get("summary"): P[x["doc"]] = x
ok = set()
for l in open("qrels.jsonl"):
    x = json.loads(l)
    if x["grade"] == 2 and x["doc"] in P: ok.add(x["qid"])
qs = sorted(ok, key=lambda q: hashlib.sha256(("20261018" + q).encode()).hexdigest())[:15]
Q = {json.loads(l)["qid"]: json.loads(l) for l in open("test-queries.jsonl")}
with open("../ab/ab-questions.jsonl", "w") as o:
    for q in qs: o.write(json.dumps({"qid": q, "text": Q[q]["text"], "need": Q[q]["need"][:600]}) + "\n")
print(len(ok), "eligible; selected", qs)
