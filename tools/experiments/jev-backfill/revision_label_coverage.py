"""Reuse exact-content finder labels for matching historical text, not approval."""
import hashlib,json,collections
from pathlib import Path

def run(current,queue,historical,out):
 labels={};ids={};out=Path(out);out.mkdir(parents=True,exist_ok=True)
 for line in Path(current).open():
  r=json.loads(line);key=hashlib.sha256((r['path']+r['sha256']+str(r['start_offset'])).encode()).hexdigest()[:24];ids[key]=r
 for line in Path(queue).open():
  r=json.loads(line);source=ids.get(r['id'])
  if source:
   key=hashlib.sha256(json.dumps({'text':source['text'],'heading':source['heading'],'ancestry':source.get('ancestry',[])},sort_keys=True).encode()).hexdigest();labels.setdefault(key,set()).add(r['category'])
 counts=collections.Counter()
 with (out/'coverage.jsonl').open('x') as dest:
  for line in Path(historical).open():
   r=json.loads(line)
   if r.get('kind')!='skill_revision_section':continue
   key=hashlib.sha256(json.dumps({'text':r['text'],'heading':r['heading'],'ancestry':r.get('ancestry',[])},sort_keys=True).encode()).hexdigest();found=labels.get(key,set());status='matching-text-label' if len(found)==1 else 'conflicting-labels' if found else 'needs-classification';counts[status]+=1
   dest.write(json.dumps({'record_id':r['record_id'],'source_path':r['source_path'],'revision_id':r.get('revision_id'),'blob_sha256':r.get('blob_sha256'),'status':status,'finder_labels':sorted(found),'semantic_review_required':True,'current_truth_inferred':False})+'\n')
 (out/'summary.json').write_text(json.dumps(dict(counts),indent=2));print(dict(counts))
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('current');p.add_argument('queue');p.add_argument('historical');p.add_argument('out');a=p.parse_args();run(a.current,a.queue,a.historical,a.out)
