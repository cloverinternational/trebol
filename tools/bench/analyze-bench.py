"""Prompt benchmark analysis per artifacts/prompt-bench/PREREG.md. Usage: analyze-bench.py results.jsonl"""
import json,random,sys,collections,statistics as st
R=[json.loads(l) for l in open(sys.argv[1])]
inv=[r for r in R if r.get('exit')!=0 or r.get('gradeError')];print('runs',len(R),'invalid',len(inv))
arms=['F','M','FM','FL'];T=sorted({r['task'] for r in R})
P={(t,a):[r['pass'] for r in R if r['task']==t and r['arm']==a and r not in inv] for t in T for a in arms}
mean=lambda x:sum(x)/len(x) if x else float('nan')
for a in arms:print(a,'pass %.3f'%mean([mean(P[t,a]) for t in T]),'| fix %.3f'%mean([mean(P[t,a]) for t in T if t.startswith('fix')]),'q %.3f'%mean([mean(P[t,a]) for t in T if t.startswith('q')]))
def boot(d):
  rng=random.Random(20261018);bs=sorted(sum(rng.choice(d) for _ in d)/len(d) for _ in range(10000));return sum(d)/len(d),bs[249],bs[9749]
for a,b in [('M','F'),('FM','F'),('FL','F'),('FM','FL')]:
  d=[mean(P[t,a])-mean(P[t,b]) for t in T];m,lo,hi=boot(d);print(f'{a}-{b} {m:+.3f} [{lo:+.3f},{hi:+.3f}]','CLAIM' if lo>0 or hi<0 else 'n.s.')

MET=['toolCalls','errors','blocked','memoryCalls','modelCalls','seconds','modeLines']
for k in MET:print('  median',k,' '.join(f"{a}:{st.median([r[k] for r in R if r['arm']==a and r not in inv and isinstance(r.get(k),(int,float))] or [0]):g}" for a in arms))

