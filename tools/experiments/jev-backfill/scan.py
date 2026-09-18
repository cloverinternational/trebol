#!/usr/bin/env python3
"""Offline explicit-root Pi inventory; no model calls, immutable per-file outputs."""
import argparse,hashlib,json,os,re,time
from pathlib import Path
MAX_LINE=8*1024*1024
RUNTIME=re.compile(r'^\s*(<system-reminder|\[SCHEDULED|\[agent completed\]|Goal check:|Work toward this goal:|## MCP Context|## Current Tasks)')
SECRET=re.compile(r'(?i)apikey_[a-z0-9_]+|\b(?:sk-|ghp_|xoxb-)[a-z0-9_-]{12,}|Bearer\s+[^\s"\']+|((?:password|api_key|secret)\s*[=:]\s*)[^\s,"\'}]+')
def redact(s):return SECRET.sub('[REDACTED]',s)
def atomic(p,v):
 tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(v,indent=2));tmp.replace(p)
def bounded_lines(f,limit=MAX_LINE):
 while True:
  offset=f.tell();raw=f.readline(limit+1)
  if not raw:break
  if len(raw)<=limit:yield offset,raw,False;continue
  digest=hashlib.sha256(raw);size=len(raw)
  while not raw.endswith(b'\n'):
   raw=f.readline(limit+1)
   if not raw:break
   digest.update(raw);size+=len(raw)
  yield offset,{'bytes':size,'sha256':digest.hexdigest()},True

def discover(home):
 roots={home/'.pi/agent/sessions'};base=sorted(roots.pop().glob('**/*.jsonl'));paths=set(base)
 for p in base:
  try:
   with p.open('rb') as f:raw=f.readline(MAX_LINE+1)
   h=json.loads(raw);cwd=h.get('cwd')
   if cwd:
    local=Path(cwd)/'.pi/agent-sessions'
    if local.is_dir():paths.update(local.glob('**/*.jsonl'))
  except (OSError,ValueError):pass
 return sorted(p for p in paths if p.is_file() and not p.is_symlink())
def extract(m):
 c=m.get('content',[])
 return c if isinstance(c,str) else '\n'.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
def scan(home,out):
 out.mkdir(parents=True,exist_ok=True);(out/'files').mkdir(exist_ok=True)
 inv=out/'inventory.json'
 if inv.exists():inventory=json.loads(inv.read_text())
 else:
  inventory=[{'path':str(p),'size':p.stat().st_size,'mtime_ns':p.stat().st_mtime_ns} for p in discover(home)];atomic(inv,inventory)
 ledger=[]
 for ordinal,entry in enumerate(inventory):
  p=Path(entry['path']);fid=hashlib.sha256(str(p).encode()).hexdigest()[:20];meta=out/'files'/f'{fid}.meta.json';dest=out/'files'/f'{fid}.events.jsonl'
  if meta.exists():ledger.append(json.loads(meta.read_text()));continue
  counts={k:0 for k in ['records','retained','chunks','excluded','malformed','oversized','duplicate']};info={**entry,'id':fid,'counts':counts,'events':str(dest),'status':'pending'};header={};seen=set();questions={}
  try:
   stat=p.stat()
   if stat.st_size!=entry['size'] or stat.st_mtime_ns!=entry['mtime_ns']:info['status']='changed-before-scan';atomic(meta,info);ledger.append(info);continue
   # Full file hash streaming separately keeps oversized-line hashing exact.
   digest=hashlib.sha256()
   with p.open('rb') as f:
    for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
   info['sha256']=digest.hexdigest()
   tmp=dest.with_suffix('.tmp')
   with p.open('rb') as f,tmp.open('w') as target:
    for line,(offset,raw,oversized) in enumerate(bounded_lines(f),1):
     counts['records']+=1
     if oversized:counts['oversized']+=1;continue
     try:r=json.loads(raw)
     except (ValueError,UnicodeError):counts['malformed']+=1;continue
     if r.get('type')=='session':header=r;counts['excluded']+=1;continue
     m=r.get('message',{});role=m.get('role');blocks=m.get('content',[])
     for b in blocks if isinstance(blocks,list) else []:
      if isinstance(b,dict) and b.get('type')=='toolCall' and b.get('name')=='ask_user_question':questions[b['id']]=b.get('arguments',{}).get('question','')
     if role not in ('user','assistant','toolResult'):counts['excluded']+=1;continue
     text=extract(m);tool=m.get('toolName','')
     if not text.strip() or RUNTIME.match(text) or re.match(r'^(context_|memory_history$|bootstrap$|SkillManage$)',tool):counts['excluded']+=1;continue
     origin=role
     if tool=='ask_user_question':
      if not text.startswith('User answered:'):counts['excluded']+=1;continue
      origin='human_answer';text='Question: '+str(questions.get(m.get('toolCallId'),'[unlinked]'))+'\n'+text
     text=redact(text);identity=hashlib.sha256((str(r.get('id'))+'\n'+text).encode()).hexdigest()
     if identity in seen:counts['duplicate']+=1;continue
     seen.add(identity);counts['retained']+=1
     for n,start in enumerate(range(0,len(text),1800)):
      part=text[start:start+1800];target.write(json.dumps({'source_id':fid,'event_id':r.get('id'),'parent_id':r.get('parentId'),'timestamp':r.get('timestamp'),'line':line,'byte_offset':offset,'origin':origin,'tool':tool,'chunk':n,'chunks':(len(text)+1799)//1800,'text':part,'sha256':hashlib.sha256(part.encode()).hexdigest()},ensure_ascii=False)+'\n');counts['chunks']+=1
   after=p.stat();info['header']={k:header.get(k) for k in ['id','cwd','parentSession','timestamp']};cwd=header.get('cwd');info['workspace_exists']=bool(cwd and Path(cwd).is_dir())
   info['status']='changed-during-scan' if (after.st_size,after.st_mtime_ns)!=(entry['size'],entry['mtime_ns']) else ('scanned-with-exceptions' if counts['malformed'] or counts['oversized'] else 'scanned')
   tmp.replace(dest)
  except (OSError,ValueError,TypeError) as e:info['status']='read-error';info['error_type']=type(e).__name__
  atomic(meta,info);ledger.append(info)
  print(json.dumps({'file':ordinal+1,'total':len(inventory),'status':info['status'],'chunks':counts['chunks']}),flush=True)
 totals={k:sum(x['counts'][k] for x in ledger) for k in ['records','retained','chunks','excluded','malformed','oversized','duplicate']};statuses={}
 for x in ledger:statuses[x['status']]=statuses.get(x['status'],0)+1
 result={'inventory_files':len(inventory),'terminal_files':len(ledger),'raw_bytes':sum(x['size'] for x in inventory),'counts':totals,'statuses':statuses,'cross_file_fork_dedup':'not applied; originals retained to avoid unproven identity collapse','files':ledger};atomic(out/'manifest.json',result)
 print(json.dumps({k:v for k,v in result.items() if k!='files'}));return result
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--home',type=Path,default=Path.home());a.add_argument('--output',type=Path,required=True);args=a.parse_args();scan(args.home,args.output)
