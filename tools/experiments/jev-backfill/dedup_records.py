"""Exact same-source/context grouping; retain all occurrence locators separately."""
import argparse,hashlib,json,sqlite3
from pathlib import Path

def run(source,output):
 output=Path(output);output.mkdir(parents=True,exist_ok=True)
 dbpath=output/'dedup.sqlite'
 if dbpath.exists():raise ValueError('Refuse overwriting dedup run')
 db=sqlite3.connect(dbpath);db.execute('create table seen (key text primary key, id text)');total=unique=0
 with Path(source).open() as src,(output/'unique.jsonl').open('x') as dest,(output/'occurrences.jsonl').open('x') as refs:
  for line in src:
   r=json.loads(line);total+=1
   # Never merge unrelated projects or task identities, even for identical prose.
   context={k:v for k,v in r.items() if k not in ('record_id','pointer','source_line','snapshot_id','snapshot_revision','start_offset','end_offset','start_line','end_line','value_char_offset')}
   key=hashlib.sha256(json.dumps(context,sort_keys=True).encode()).hexdigest();old=db.execute('select id from seen where key=?',(key,)).fetchone()
   canonical=old[0] if old else r['record_id']
   if not old:db.execute('insert into seen values (?,?)',(key,canonical));dest.write(line);unique+=1
   refs.write(json.dumps({'canonical_id':canonical,'occurrence':{k:r[k] for k in ('record_id','source_path','source_sha256','pointer','source_line','snapshot_id','start_offset','end_offset') if k in r}})+'\n')
 db.commit();db.close();summary={'input_records':total,'unique_records':unique,'exact_context_duplicates':total-unique,'source_deletions':0,'cross_source_merges':0};(output/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('output');a=p.parse_args();run(a.source,a.output)
