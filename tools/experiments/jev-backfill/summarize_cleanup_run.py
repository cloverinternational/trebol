"""Convert finder results into a conservative cleanup queue; no source mutations."""
import argparse,collections,json
from pathlib import Path

def summarize(root):
 root=Path(root);plan=json.loads((root/'plan.json').read_text());counts=collections.Counter();rows=[];failed=0
 for p in sorted(root.glob('*.json')):
  if len(p.stem)!=64:continue
  d=json.loads(p.read_text())
  if d.get('status')!='completed':failed+=1;continue
  for f,s in zip(d['findings'],d['sources']):
   counts[f['category']]+=1
   action={'procedure':'retain-procedure-review','memory':'verify-project-memory','mixed':'prepare-reversible-split','temporary':'review-expiry-not-delete','unresolved':'review-evidence','noise':'review-noise-not-delete'}[f['category']]
   rows.append({**s,**f,'proposed_action':action,'review_required':True,'low_confidence':f['confidence']<.65,'applied':False})
 (root/'cleanup-queue.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
 summary={'classified_chunks':len(rows),'categories':dict(counts),'low_confidence':sum(r['low_confidence'] for r in rows),'failed_batches':failed,'eligible_chunks':plan['eligibleChunks'],'excluded_chunks':len(plan['exclusions']),'mutations':0,'not_semantic_approval':True}
 (root/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root');a=p.parse_args();summarize(a.root)
