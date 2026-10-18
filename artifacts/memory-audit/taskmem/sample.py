# Seeded sample of 25 answered TaskManage candidate records (latest revision), for manual labelling.
import json, os, glob, random
root=os.path.expanduser("~/.swarm/memory/knowledge"); latest={}
for p in glob.glob(root+"/*/*/**/*.json", recursive=True):
    try: e=json.load(open(p))
    except Exception: continue
    r=e.get("record",{})
    if not r.get("source","").startswith("taskmanage:"): continue
    k=r["id"]; n=os.path.basename(p)
    if k not in latest or n>latest[k][0]: latest[k]=(n,r)
pool=sorted([(k,json.loads(r["text"])) for k,(n,r) in latest.items() if any(q["answer"] for q in json.loads(r["text"])["questions"])])
random.seed(20261018); s=random.sample(pool,25)
for i,(k,c) in enumerate(s,1):
    print(f"## S{i:02d} {k[:8]} [{c['status']}] {c['subject'][:110]}")
    for q in [q for q in c["questions"] if q["answer"]][:2]:
        print(f"  Q {q['question'][:140]}\n  A {q['answer'][:300]}\n  E {q['evidence'][:140]}")
print(f"pool={len(pool)}")
