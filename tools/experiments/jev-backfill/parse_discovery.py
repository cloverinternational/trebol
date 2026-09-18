"""Parse discovered text/task containers; every file gets a terminal receipt."""
import argparse,collections,hashlib,json
from pathlib import Path
from corpus_parse import markdown_sections,section_chunks,task_records,redact,digest
from revision_extract import revision_records
MAX=32*1024*1024

def extract_tasks(data,prefix=''):
 if not isinstance(data,dict):return
 tasks=data.get('tasks')
 if tasks is None:return
 if isinstance(tasks,dict):items=tasks.items()
 elif isinstance(tasks,list):items=enumerate(tasks)
 else:raise ValueError('unsupported task container')
 for key,t in items:
  if not isinstance(t,dict):continue
  for pointer,field,value in task_records(t,f'{prefix}/tasks/{key}'):
   text=value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)
   for pos in range(0,len(text),4000):yield {'kind':'task_field','pointer':pointer,'field':field,'task_id':t.get('id',str(key)),'task_status':t.get('status'),'task_subject':redact(str(t.get('subject','')))[:500],'time':t.get('updated_at',t.get('updatedAt')),'conversation_id':data.get('conversation_id'),'ownership':'unresolved','value_char_offset':pos,'text':redact(text[pos:pos+4000])}

def run(inventory,output):
 output=Path(output);output.mkdir(parents=True,exist_ok=True);counts=collections.Counter();kinds=collections.Counter()
 with (output/'records.jsonl').open('x') as dest,(output/'receipts.jsonl').open('x') as receipts:
  for line in Path(inventory).open():
   src=json.loads(line)
   if src['outcome']!='candidate':continue
   p=Path(src['path']);n=0;outcome='parsed'
   def emit(r):
    nonlocal n
    r.update(source_path=str(p),source_sha256=src['sha256'],placement=src['placement']);r['record_id']=hashlib.sha256(json.dumps(r,sort_keys=True).encode()).hexdigest();dest.write(json.dumps(r,ensure_ascii=False)+'\n');n+=1;kinds[r['kind']]+=1
   try:
    if src['bytes']>MAX and src['kind']!='pi-session':outcome='oversized-deferred'
    elif digest(p)!=src['sha256']:outcome='changed-since-inventory'
    elif src['kind']=='skills' and p.suffix.lower() in ('.md','.txt'):
     for section in markdown_sections(p.read_text()):
      for chunk in section_chunks(section):emit({'kind':'skill_section','heading':redact(section['heading']),'ancestry':[redact(v) for v in section['ancestry']],'ownership':'unresolved',**chunk})
    elif p.suffix=='.json':
     data=json.loads(p.read_text())
     if 'tasks' in data:
      for row in extract_tasks(data):emit(row)
     elif src['kind']=='task-metadata' and isinstance(data.get('payload'),dict):
      payload=data['payload'];field=payload.get('field_name')
      if data.get('event_type')=='task.created' and isinstance(payload.get('fields'),dict):
       task={**payload['fields'],'id':payload.get('task_id',data.get('task_id'))}
       for row in extract_tasks({'tasks':[task],'conversation_id':data.get('conversation_id')}):emit({**row,'pointer':row['pointer'].replace('/tasks/0/','/payload/fields/',1),'kind':'task_created_snapshot','time':data.get('recorded_at'),'event_type':data['event_type'],'journal_record_id':data.get('record_id')})
       field='__created__'
      if field in ('description','subject','questions','answers','notes','typed_notes'):
       text=json.dumps(payload.get('new_value'),ensure_ascii=False)
       for pos in range(0,len(text),4000):emit({'kind':'task_journal_field','pointer':'/payload/new_value','field':field,'task_id':data.get('task_id'),'conversation_id':data.get('conversation_id'),'time':data.get('recorded_at'),'event_type':data.get('event_type'),'predecessor':data.get('predecessor_record_id'),'ownership':'unresolved','text':redact(text[pos:pos+4000]),'value_char_offset':pos})
      elif field=='__created__':pass
      elif data.get('event_type')=='task.deleted':outcome='lifecycle-only-deletion'
      elif field in ('status','active','last_seen','updated_at','updatedAt','completed_at','sequence','priority','category','active_form','blocks','depends_on','created_at'):outcome='lifecycle-only-field'
      else:outcome='unsupported-journal-event'
     elif 'tail_record_id' in data and 'record_count' in data:outcome='journal-anchor-metadata'
     elif src['kind']=='skills' and 'format' in data and 'action' in data:
      for row in revision_records(data,p):emit(row)
     elif isinstance(data.get('goal'),dict):
      for field in ('condition','last_reason'):
       value=data['goal'].get(field)
       if isinstance(value,str):
        for pos in range(0,len(value),4000):emit({'kind':'goal_field','pointer':'/goal/'+field,'text':redact(value[pos:pos+4000]),'value_char_offset':pos,'goal_state':data['goal'].get('state'),'time':data['goal'].get('created_at'),'ownership':'unresolved'})
     else:outcome='unsupported-json-schema'
    elif src['kind']=='pi-session':
     with p.open('rb') as f:
      index=0
      while True:
       line=f.readline(MAX+1)
       if not line:break
       index+=1
       if len(line)>MAX:
        while line and not line.endswith(b'\n'):line=f.readline(MAX+1)
        outcome='partial-oversized-lines';continue
       try:entry=json.loads(line)
       except ValueError:outcome='partial-malformed-lines';continue
       if entry.get('customType')=='pi-swarm-task-state' or entry.get('type')=='pi-swarm-task-state':
        data=entry.get('data',{});wrapped=isinstance(data,dict) and isinstance(data.get('state'),dict);data=data.get('state',data) if isinstance(data,dict) else data
        for row in extract_tasks(data,'/data/state' if wrapped else '/data'):emit({**row,'source_line':index,'snapshot_id':entry.get('id'),'snapshot_revision':data.get('revision') if isinstance(data,dict) else None})
    else:outcome='unsupported-format'
    if outcome=='parsed' and not n:outcome='empty-or-no-task-records'
   except (OSError,ValueError,TypeError) as e:outcome='error:'+type(e).__name__
   counts[outcome]+=1;receipts.write(json.dumps({'path':str(p),'sha256':src['sha256'],'outcome':outcome,'records':n})+'\n')
 summary={'files':dict(counts),'records':dict(kinds),'paid_calls':0,'complete':False,'limitations':['changed and malformed sources need follow-up','non-text revision assets excluded','redaction heuristic','run separate conservative dedup before classification']};(output/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('inventory');p.add_argument('output');a=p.parse_args();run(a.inventory,a.output)
