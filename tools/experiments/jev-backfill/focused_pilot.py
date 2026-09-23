"""Focused project corpus intake; bounded within original100-call authorization."""
import json,os,urllib.request,time
from pathlib import Path
from pilot import C
B=Path('artifacts/jev-backfill/staged-scan-v2')
def main():
 manifest=json.load(open(B/'manifest.json'));mapping=json.load(open(B/'project-map.json'));ids={x['source_id'] for x in mapping['rows'] if x['mapping'].get('target_cwd')=='/home/swarm/Work/Pi-Swarm'}
 out=B/'pilot';ledger=out/'calls.jsonl';reserved=[json.loads(l) for l in ledger.read_text().splitlines()];done={x['file_id'] for x in reserved};used=len(reserved);calls=0
 files=sorted([f for f in manifest['files'] if f['id'] in ids and f['status']=='scanned'],key=lambda f:f.get('header',{}).get('timestamp') or '',reverse=True)
 for f in files:
  if f['id'] in done or calls>=12 or used>=100:continue
  batch=[]
  with Path(f['events']).open() as src:
   for line in src:
    e=json.loads(line)
    # Complete modest-size user/assistant passages; avoid slicing conclusions.
    if e['origin'] not in ('user','human_answer','assistant') or e['chunks']!=1 or len(e['text'])<100:continue
    batch.append(e)
  # End-of-session material, not the same initial request in every prior sample.
  batch=batch[-6:]
  if not batch:continue
  q={f'e{i}':{'type':'choice','instructions':f'Classify evidence[{i}] for useful future project knowledge. Assistant prose can propose a fact but is NOT verification. Prefer memory for concrete architecture decisions, implementation constraints, operational facts, or durable user preferences; not requests to do a one-time task. Generic how-to goes to procedure.', 'criteria':C} for i in range(len(batch))}
  payload={'model':'jev-1.13.0','state':{'evidence':batch},'questions':q};(out/(f['id']+'.request.json')).write_text(json.dumps(payload))
  row={'file_id':f['id'],'workspace':'/home/swarm/Work/Pi-Swarm','status':'reserved','evidence_count':len(batch),'pilot':'focused-project'}
  with ledger.open('a') as d:d.write(json.dumps(row)+'\n');d.flush();os.fsync(d.fileno())
  used+=1;calls+=1
  try:
   req=urllib.request.Request('https://api.typesafe.ai/v1/systemone',data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+os.environ['TYPESAFE_API_KEY'],'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=10) as res:value=json.load(res)
   row.update(status='completed',result=value,usage=value.get('usage',{}))
  except Exception as e:row.update(status='failed',error_type=type(e).__name__)
  (out/(f['id']+'.result.json')).write_text(json.dumps(row,indent=2));print(f['id'],row['status'],flush=True)
 print('new_calls',calls,'total_reserved',used)
if __name__=='__main__':main()
