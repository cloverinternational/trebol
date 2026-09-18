#!/usr/bin/env python3
"""Read-only bounded parser for skills/task backfill corpus."""
from __future__ import annotations
import argparse, hashlib, json, os, re
from pathlib import Path
MAX_FILE=32*1024*1024
SKIP_DIRS={'.history','.cache','__pycache__'}
SECRET=re.compile(r'(?i)(?:apikey_[A-Za-z0-9_-]+|(?:sk|ghp|xox[baprs])-[A-Za-z0-9_-]{12,}|Bearer\s+[^\s"\']+|(?:password|api[_-]?key|secret|token)\s*[:=]\s*[^\s,;]+)')
def redact(s):
 s=re.sub(r'gh[pousr]_[A-Za-z0-9_]{12,}', '[REDACTED]',s)
 if re.search(r'(?i)(vault_exec|\"secret\"\s*:|BEGIN .*PRIVATE KEY)',s): return '[OMITTED: potential credential payload]'
 return SECRET.sub('[REDACTED]',s)
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
def inventory(roots):
 for root,label in roots:
  root=Path(root).expanduser()
  if not root.exists(): yield {'kind':'unsupported','path':str(root),'reason':'missing-root'}; continue
  for base,dirs,files in os.walk(root,followlinks=False):
   dirs[:]=sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(base)/d).is_symlink())
   for name in sorted(files):
    if label=='conversations' and not (name=='task.json' and Path(base).name=='metadata'): continue
    p=Path(base)/name
    if p.is_symlink(): yield {'kind':'unsupported','path':str(p),'reason':'symlink'}; continue
    if label=='skills' and name!='SKILL.md': yield {'kind':'unsupported','path':str(p),'reason':'skill-support-file-omitted'}; continue
    try: st=p.stat()
    except OSError as e: yield {'kind':'error','path':str(p),'reason':type(e).__name__}; continue
    if st.st_size>MAX_FILE: yield {'kind':'oversize','path':str(p),'bytes':st.st_size}; continue
    yield {'kind':'file','path':str(p),'label':label,'bytes':st.st_size,'sha256':digest(p)}
def markdown_sections(text):
 lines=text.splitlines(keepends=True);out=[];front=False;fence=None;cur=None;stack=[];offset=0
 for no,line in enumerate(lines,1):
  start=offset;offset+=len(line);stripped=line.strip()
  if no==1 and stripped=='---':front=True;continue
  if front:
   if stripped in ('---','...'):front=False
   continue
  mark=re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$',line.rstrip('\r\n'))
  heading=re.match(r'^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$',line.rstrip('\r\n')) if not fence else None
  if heading:
   if cur:cur['end_line']=no-1;cur['end_offset']=start;out.append(cur)
   level=len(heading[1]);title=heading[2]
   while stack and stack[-1][0]>=level:stack.pop()
   stack.append((level,title));cur={'heading':title,'ancestry':[v for _,v in stack],'level':level,'start_line':no,'start_offset':start,'text':''}
  if cur is None:cur={'heading':'Preamble','ancestry':[],'level':0,'start_line':no,'start_offset':start,'text':''}
  cur['text']+=line
  if mark:
   delimiter=mark[1]
   if fence is None:fence=(delimiter[0],len(delimiter))
   elif delimiter[0]==fence[0] and len(delimiter)>=fence[1] and not mark[2].strip():fence=None
 if cur:cur['end_line']=len(lines);cur['end_offset']=len(text);out.append(cur)
 return out

def section_chunks(section,size=4000):
 raw=section['text'];parts=[]
 for offset in range(0,len(raw),size):
  original=raw[offset:offset+size];clean=redact(original)
  parts.append({'text':clean,'start_offset':section['start_offset']+offset,'end_offset':section['start_offset']+offset+len(original),'start_line':section['start_line']+raw.count('\n',0,offset),'end_line':section['start_line']+raw.count('\n',0,offset+max(0,len(original)-1)),'redacted':clean!=original})
 return parts
def chunks(text,size=4000):
 text=redact(text); return [text[i:i+size] for i in range(0,len(text),size)] or ['']
def task_records(task,path=''):
 for field in ('subject','description','questions','answers','notes','typed_notes'):
  value=task.get(field)
  if value is None: continue
  if isinstance(value,list):
   for i,part in enumerate(value): yield f'{path}/{field}/{i}',field,part
  else: yield f'{path}/{field}',field,value
def parse_task(item):
 try: data=json.loads(Path(item['path']).read_text())
 except Exception as e: return [],{'kind':'error','path':item['path'],'reason':type(e).__name__}
 tasks=data.get('tasks',[]) if isinstance(data,dict) else []
 if tasks is None: tasks=[]
 if not isinstance(tasks,list): return [],{'kind':'error','path':item['path'],'reason':'tasks-not-array'}
 rows=[]
 for i,t in enumerate(tasks):
  if not isinstance(t,dict): continue
  base={'source_path':item['path'],'source_sha256':item['sha256'],'task_index':i,'task_id':t.get('id') or t.get('taskId'),'status':t.get('status'),'conversation_id':data.get('conversationId') or data.get('conversation_id'),'time':t.get('updated_at') or t.get('updatedAt') or t.get('created_at') or t.get('createdAt') or t.get('timestamp'),'ownership':'unresolved','task_subject':redact(str(t.get('subject',''))),'task_context':redact(str(t.get('description','')))[:1200]}
  for ptr,field,val in task_records(t,f'/tasks/{i}'):
   text=json.dumps(val,ensure_ascii=False) if not isinstance(val,str) else val; parts=chunks(text)
   for n,part in enumerate(parts): rows.append({'kind':'task_field',**base,'field':field,'json_pointer':ptr,'chunk':n,'chunks':len(parts),'text':part})
 return rows,None
def parse(a):
 out=Path(a.output); out.mkdir(parents=True,exist_ok=True);
 if (out/'manifest.json').exists(): raise ValueError('Refuse overwriting completed corpus')
 counts={}; records=0; errors=[]; reps=[]
 with (out/'corpus.jsonl').open('w') as dest:
  for item in inventory([(a.skills,'skills'),(a.conversations,'conversations')]):
   counts[item['kind']]=counts.get(item['kind'],0)+1
   if item['kind']!='file': dest.write(json.dumps(item)+'\n'); continue
   try:
    if item['label']=='skills':
     text=Path(item['path']).read_text(); secs=markdown_sections(text)
     for sec in secs:
      parts=chunks(sec['text'])
      for n,part in enumerate(parts):
       row={'kind':'skill_section','source_path':item['path'],'source_sha256':item['sha256'],'corpus_label':('archive' if 'archive' in Path(item['path']).relative_to(Path(a.skills).expanduser()).parts else 'active'),'heading':sec['heading'],'level':sec['level'],'start_line':sec['start_line'],'end_line':sec['end_line'],'chunk':n,'chunks':len(parts),'text':part,'ownership':'unresolved'}; dest.write(json.dumps(row,ensure_ascii=False)+'\n'); records+=1
      if len(reps)<5: reps.append(item['path'])
    else:
     rows,err=parse_task(item)
     if err: counts['error']=counts.get('error',0)+1; dest.write(json.dumps(err)+'\n')
     for row in rows: dest.write(json.dumps(row,ensure_ascii=False)+'\n'); records+=1
   except Exception as e: errors.append({'path':item['path'],'reason':type(e).__name__}); counts['error']=counts.get('error',0)+1
 manifest={'records':records,'inventory_counts':counts,'errors':errors,'representative_paths':reps,'redaction':'pattern-based, not perfect sanitization; vault fragments skipped only when identified','read_only':True}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n'); print(json.dumps(manifest))
if __name__=='__main__':
 p=argparse.ArgumentParser(); p.add_argument('--skills',default='~/.swarm/skills/autogen'); p.add_argument('--conversations',default='~/.swarm/conversations'); p.add_argument('--output',required=True); parse(p.parse_args())
