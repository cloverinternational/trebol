"""Conservative fork dedup plan. Never removes sources or merges unrelated text."""
import argparse,hashlib,json,sqlite3
from pathlib import Path

def build(scan):
 scan=scan.resolve();manifest=json.loads((scan/'manifest.json').read_text());mapping=json.loads((scan/'project-map.json').read_text());maps={r['source_id']:r['mapping'] for r in mapping['rows']};files={str(Path(f['path']).resolve()):f for f in manifest['files']};byid={f['id']:f for f in files.values()};edges={};unresolved=[]
 for f in files.values():
  parent=f.get('header',{}).get('parentSession')
  if not parent:continue
  # Relative parent paths have no proven base; do not guess.
  if not isinstance(parent,str) or not Path(parent).is_absolute() or str(Path(parent).resolve()) not in files:unresolved.append(f['id']);continue
  p=files[str(Path(parent).resolve())];a=maps.get(f['id'],{});b=maps.get(p['id'],{})
  if a.get('status')!='mapped' or a.get('repository_key')!=b.get('repository_key'):unresolved.append(f['id']);continue
  edges[f['id']]=p['id']
 def ancestors(fid):
  seen=set();current=edges.get(fid)
  while current:
   if current in seen:return []
   seen.add(current);current=edges.get(current)
  return list(seen)
 target=scan/'lineage-index.sqlite'
 if target.exists():raise ValueError('Refuse overwriting lineage index')
 db=sqlite3.connect(target);db.execute('create table seen(source text,event text,parent text,chunk integer,hash text,primary key(source,event,chunk))');count=0;dups=0
 out=scan/'lineage-dispositions.jsonl'
 ordered=sorted(files.values(),key=lambda f:(len(ancestors(f['id'])),f['id']))
 with out.open('w') as dest:
  for f in ordered:
   if f['status']!='scanned':continue
   p=Path(f['events']);p=p if p.is_absolute() else Path.cwd()/p
   if not p.resolve().is_relative_to(scan):raise ValueError('events outside scan')
   parents=ancestors(f['id'])
   with p.open() as src:
    for line in src:
     e=json.loads(line);duplicate=None
     for parent in parents:
      row=db.execute('select hash,parent from seen where source=? and event=? and chunk=?',(parent,e['event_id'],e['chunk'])).fetchone()
      if row and row==(e['sha256'],e.get('parent_id')):duplicate=parent;break
     db.execute('insert or ignore into seen values(?,?,?,?,?)',(f['id'],e['event_id'],e.get('parent_id'),e['chunk'],e['sha256']))
     count+=1;dups+=int(duplicate is not None)
     dest.write(json.dumps({'source_id':f['id'],'event_id':e['event_id'],'chunk':e['chunk'],'status':'duplicate_in_proven_ancestor' if duplicate else 'retain','ancestor':duplicate})+'\n')
   db.commit()
 db.close();summary={'scanned_chunks':count,'proven_duplicate_chunks':dups,'retained_chunks':count-dups,'proven_parent_edges':len(edges),'unresolved_parent_links':len(unresolved),'source_deletions':0,'cross_project_merges':0};(scan/'lineage-summary.json').write_text(json.dumps(summary,indent=2));return summary
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('scan',type=Path);args=a.parse_args();print(json.dumps(build(args.scan)))
