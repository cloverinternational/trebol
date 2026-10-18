import json, random, hashlib
Q={json.loads(l)['qid']:json.loads(l) for l in open('test-queries.jsonl')}
R={json.loads(l)['qid']:json.loads(l) for l in open('runs.jsonl')}
M={json.loads(l)['qid']:json.loads(l) for l in open('memory-run.jsonl')}
P={}
for l in open('passages.jsonl'):
    x=json.loads(l); P[x['doc']]=x
rng=random.Random(20261018)
pool={}; key={}
for qid in sorted(Q):
    docs={}
    for arm,lst in R[qid]['runs'].items():
        for d in lst[:10]:
            p=P[d]; docs[d]=f"{p['ref']}#L{p['lines'][0]}-L{p['lines'][1]}\n{p['text'][:1200]}" if p.get('lines') else f"{p['ref']}\n{p['text'][:1200]}"
    for it in M[qid]['run'][:10]:
        docs[it['doc']]="[memory note, "+it['createdAt'][:10]+"]\n"+it['text'][:1200]
    ids=sorted(docs); rng.shuffle(ids)
    items=[]
    for i,d in enumerate(ids):
        h=f"{qid}-{i:03d}"; key[h]=d; items.append({"h":h,"text":docs[d]})
    q=Q[qid]
    pool[qid]={"qid":qid,"query":q['text'],"need":q['need'][:600],"next_files":q['next_files'][:8],"edited_or_committed":sorted(set(q['next_edited']+q['commit_files']))[:15],"items":items}
json.dump(key,open('pool-key.json','w'))
qs=sorted(pool); n=len(qs)
batches=[qs[i::6] for i in range(6)]
for b,ql in enumerate(batches):
    with open(f'judge-batch-{b}.json','w') as f: json.dump([pool[q] for q in ql],f,indent=0)
print(sum(len(pool[q]['items']) for q in qs), [sum(len(pool[q]['items']) for q in ql) for ql in batches])
import os; print([os.path.getsize(f'judge-batch-{b}.json') for b in range(6)])
