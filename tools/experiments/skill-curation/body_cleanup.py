"""Repeatable body cleanup plans and reversible previews. Never edits skills.
plan consumes existing Jev labels; preview requires explicit reviewed decisions.
"""
import argparse,hashlib,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'jev-backfill'))
from corpus_parse import markdown_sections

def sha(b):return hashlib.sha256(b).hexdigest()
def save(path,value):path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
def plan(root,findings,out):
 root=Path(root).expanduser().resolve();out=Path(out);out.mkdir(parents=True,exist_ok=True);labels={}
 if findings:
  for line in Path(findings).open():
   row=json.loads(line);labels.setdefault(row['path'],[]).append(row)
 skills=[]
 for p in sorted(root.glob('*/SKILL.md')):
  if p.parent.name.startswith('.') or p.parent.name=='archive' or p.is_symlink() or p.parent.is_symlink():continue
  raw=p.read_bytes();digest=sha(raw);text=raw.decode();sections=[]
  for section in markdown_sections(text):
   # Only top-level body units (H2); nested content is preserved inside the span.
   if section['level']!=2:continue
   start=section['start_offset'];sections.append({'heading':section['heading'],'start':start})
  for i,section in enumerate(sections):
   section['end']=sections[i+1]['start'] if i+1<len(sections) else len(text)
   fragment=text[section['start']:section['end']];section['section_sha256']=sha(fragment.encode());section['id']=sha((str(p)+'\n'+digest+'\n'+str(section['start'])).encode())[:24]
   section['characters']=len(fragment);matches=[r for r in labels.get(str(p),[]) if r.get('sha256')==digest and r['start']<section['end'] and r['end']>section['start']]
   section['finder_labels']=sorted(set(r['category'] for r in matches));section['review_status']='pending';section['action']='retain-until-reviewed'
  skills.append({'name':p.parent.name,'source':str(p),'source_sha256':digest,'bytes':len(raw),'sections':sections,'stale_finding_count':sum(r.get('sha256')!=digest for r in labels.get(str(p),[]))})
 skills.sort(key=lambda r:(-r['bytes'],r['name']));result={'version':1,'source_root':str(root),'source_mutations':0,'skills':skills};save(out/'plan.json',result);return result

def preview(planfile,decisionsfile,out):
 plan=json.loads(Path(planfile).read_text());decisions=json.loads(Path(decisionsfile).read_text());out=Path(out)
 index={s['id']:(skill,s) for skill in plan['skills'] for s in skill['sections']};grouped={};seen=set()
 for d in decisions:
  if d.get('action')=='retain':continue
  if d.get('action')!='split' or d.get('reviewed') is not True or not d.get('reviewer') or not d.get('rationale') or not isinstance(d.get('procedure'),str) or not d['procedure'].strip():raise ValueError('Explicit reviewed split and procedure required')
  sid=d['id']
  if sid in seen or sid not in index:raise ValueError('Duplicate or unknown decision')
  seen.add(sid);skill,s=index[sid];grouped.setdefault(skill['name'],(skill,[]))[1].append((s,d))
 # Preflight every source before writing any preview.
 for skill,pairs in grouped.values():
  if sha(Path(skill['source']).read_bytes())!=skill['source_sha256']:raise ValueError('Source changed; replan and review')
 out.mkdir(parents=True,exist_ok=True);receipts=[]
 for name,(skill,pairs) in grouped.items():
  original=Path(skill['source']).read_bytes();text=original.decode();chunks=[];segments=[];cursor=0;files={}
  for s,d in sorted(pairs,key=lambda pair:pair[0]['start']):
   start,end=s['start'],s['end'];preserved=text[start:end];ref='references/curation-history/'+s['id']+'.md'
   replacement=d['procedure'].rstrip()+f'\n\nBefore applying this section, read [{s["heading"]}]({ref}) for preserved historical evidence and constraints. Historical claims require current source verification.\n\n'
   chunks.extend([text[cursor:start],replacement]);files[ref]=preserved;segments.append({'start':start,'end':end,'replacement':replacement,'reference':ref,'section_sha256':sha(preserved.encode()),'reviewer':d['reviewer'],'rationale':d['rationale']});cursor=end
  chunks.append(text[cursor:]);body=''.join(chunks);manifest={'source':skill['source'],'source_sha256':skill['source_sha256'],'preview_sha256':sha(body.encode()),'segments':segments,'applied':False,'publication':'Fresh SkillManage view; write support files before patch with latest expectedRevision. No automated memory promotion.'}
  folder=out/name
  if folder.exists():
   if json.loads((folder/'manifest.json').read_text())!=manifest:raise ValueError('Existing preview differs; choose new run')
   verify(folder);receipts.append({'name':name,'reused':True});continue
  folder.mkdir()
  for ref,content in files.items():p=folder/ref;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(content.encode())
  (folder/'SKILL.preview.md').write_bytes(body.encode());save(folder/'manifest.json',manifest);verify(folder);receipts.append({'name':name,'reused':False})
 return receipts

def verify(folder):
 folder=Path(folder);m=json.loads((folder/'manifest.json').read_text());text=(folder/'SKILL.preview.md').read_text();
 if sha(text.encode())!=m['preview_sha256']:raise ValueError('Preview changed')
 for segment in reversed(m['segments']):
  shift=sum(len(s['replacement'])-(s['end']-s['start']) for s in m['segments'] if s['start']<segment['start']);at=segment['start']+shift;ref=Path(segment['reference'])
  if ref.is_absolute() or '..' in ref.parts:raise ValueError('Unsafe reference')
  old=(folder/ref).read_text()
  if sha(old.encode())!=segment['section_sha256'] or text[at:at+len(segment['replacement'])]!=segment['replacement']:raise ValueError('Preserved section changed')
  text=text[:at]+old+text[at+len(segment['replacement']):]
 if sha(text.encode())!=m['source_sha256']:raise ValueError('Reconstruction failed')
 return True
if __name__=='__main__':
 p=argparse.ArgumentParser();sub=p.add_subparsers(dest='cmd',required=True)
 a=sub.add_parser('plan');a.add_argument('--root',required=True);a.add_argument('--findings');a.add_argument('--out',required=True)
 a=sub.add_parser('preview');a.add_argument('--plan',required=True);a.add_argument('--decisions',required=True);a.add_argument('--out',required=True)
 a=sub.add_parser('verify');a.add_argument('folder');args=p.parse_args()
 if args.cmd=='plan':r=plan(args.root,args.findings,args.out);print(json.dumps({'skills':len(r['skills']),'sections':sum(len(s['sections']) for s in r['skills'])}))
 elif args.cmd=='preview':print(json.dumps(preview(args.plan,args.decisions,args.out)))
 else:print(json.dumps({'verified':verify(args.folder)}))
