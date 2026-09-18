"""Account for candidate sources without changing them or reading credentials."""
import argparse,hashlib,json,os
from pathlib import Path
SKIP={'.cache','node_modules','.git'}
SENSITIVE=('credential','secret','token','private-key','.env','vault')
def discover(roots):
 for kind,root in roots:
  root=Path(root).expanduser()
  if not root.exists():yield {'kind':kind,'path':str(root),'outcome':'missing-root'};continue
  for base,dirs,files in os.walk(root,followlinks=False):
   for name in sorted(dirs[:]):
    p=Path(base)/name
    if p.is_symlink() or name in SKIP:
     dirs.remove(name);yield {'kind':kind,'path':str(p),'outcome':'excluded-directory','reason':'symlink' if p.is_symlink() else 'cache-or-dependency'}
   dirs.sort()
   for name in sorted(files):
    p=Path(base)/name;rel=p.relative_to(root);row={'kind':kind,'path':str(p),'placement':'archive' if 'archive' in rel.parts else 'history' if '.history' in rel.parts else 'current','ownership':'unresolved'}
    if p.is_symlink():yield {**row,'outcome':'excluded','reason':'symlink'};continue
    if any(s in name.lower() for s in SENSITIVE):yield {**row,'outcome':'excluded','reason':'sensitive-name'};continue
    eligible=(kind=='skills' and p.suffix.lower() in ('.md','.txt','.json')) or (kind=='task-metadata' and ('metadata' in rel.parts or kind=='task-store') and p.suffix in ('.json','.jsonl')) or (kind=='task-store' and p.suffix in ('.json','.jsonl')) or (kind=='pi-session' and p.suffix=='.jsonl')
    if not eligible:yield {**row,'outcome':'excluded','reason':'unsupported-or-nontask-container'};continue
    try:
     before=p.stat();h=hashlib.sha256()
     with p.open('rb') as f:
      for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
     after=p.stat()
     yield {**row,'bytes':before.st_size,'mtime_ns':before.st_mtime_ns,'sha256':h.hexdigest(),'outcome':'candidate' if (before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns) else 'changed-during-read','format': 'pi-task-snapshot-container' if kind=='pi-session' else 'skill-body' if name=='SKILL.md' else 'skill-support-or-revision' if kind=='skills' else 'task-metadata-container'}
    except OSError as e:yield {**row,'outcome':'error','reason':type(e).__name__}
def run(output,home):
 output=Path(output);output.mkdir(parents=True,exist_ok=True)
 dest=output/'inventory.jsonl'
 if dest.exists():raise ValueError('Refuse overwriting inventory')
 import collections
 counts=collections.Counter();totalbytes=0
 roots=[('skills',home/'.swarm/skills/autogen'),('task-metadata',home/'.swarm/conversations'),('task-store',home/'.swarm/tasks'),('pi-session',home/'.pi/agent/sessions')]
 with dest.open('x') as out:
  for r in discover(roots):out.write(json.dumps(r)+'\n');counts[r['kind']+':'+r['outcome']]+=1;totalbytes+=r.get('bytes',0)
 summary={'counts':dict(counts),'hashed_bytes':totalbytes,'sources':[str(p) for _,p in roots],'complete_scope':'listed roots only; discovery is not parsing or classification','omissions':['other Swarm home variants not yet audited','non-text skill assets','custom runtime task-store roots'],'paid_calls':0}
 (output/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary))
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--output',required=True);a.add_argument('--home',type=Path,default=Path.home());v=a.parse_args();run(v.output,v.home)
