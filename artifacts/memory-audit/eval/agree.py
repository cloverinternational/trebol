import json, glob, collections, sys
def kappa(pairs, f=lambda x:x):
    pa=[(f(a),f(b)) for a,b in pairs]; n=len(pa); po=sum(a==b for a,b in pa)/n
    ca=collections.Counter(a for a,_ in pa); cb=collections.Counter(b for _,b in pa)
    pe=sum(ca[k]*cb[k] for k in set(ca)|set(cb))/n/n; return (po-pe)/(1-pe), po
A={};B={};need={}
for b in range(6):
    for x in json.load(open(f'judge-batch-{b}.json')):
        for it in x['items']: need[it['h']]=b
    for J,D in (("A",A),("B",B)):
        try: D.update({k:int(v) for k,v in json.load(open(f'judgments-{J}-{b}.json')).items()})
        except FileNotFoundError: pass
both=[h for h in need if h in A and h in B]
missing={J:[h for h in need if h in A or True if (h not in D and any(need[h]==b for b in range(6)))] for J,D in ()}
pairs=[(A[h],B[h]) for h in both]
print("items",len(need),"A",len(A),"B",len(B),"both",len(both))
print("kappa3 %.3f po %.3f"%kappa(pairs)); print("kappa_bin %.3f po %.3f"%kappa(pairs,lambda x:int(x>=1)))
print("dist A",collections.Counter(A[h] for h in both),"B",collections.Counter(B[h] for h in both))
d=[h for h in both if A[h]!=B[h]]; print("disagree",len(d),"of which 2v0",sum(abs(A[h]-B[h])==2 for h in d))
json.dump(sorted(d),open('disagreements.json','w'))
