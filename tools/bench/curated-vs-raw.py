"""Addendum primary: paired hit@5 curated vs raw (hybrid; bm25 secondary). 10k bootstrap, seed 20261018."""
import json,random,sys
a={r['qid']:r for r in json.load(open(sys.argv[1]))['rows']};b={r['qid']:r for r in json.load(open(sys.argv[2]))['rows']}
for m in ['hybrid','bm25','dense']:
  d=[b[q][m]['hit5']-a[q][m]['hit5'] for q in a];rng=random.Random(20261018);bs=sorted(sum(rng.choice(d) for _ in d)/len(d) for _ in range(10000))
  print(m,'raw',sum(a[q][m]['hit5'] for q in a),'curated',sum(b[q][m]['hit5'] for q in a),'of',len(a),'delta %.3f CI95 [%.3f, %.3f]'%(sum(d)/len(d),bs[249],bs[9749]),'flips +%d -%d'%(d.count(1),d.count(-1)))
