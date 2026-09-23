"""Complete leaf-file accounting for skill root, including indirect blob coverage.
No skill mutation; read-only cleanup queue, not permission to apply it.
"""
import argparse,collections,hashlib,json,os
from pathlib import Path
from corpus_parse import markdown_sections,section_chunks,redact
TEXT={'.md','.txt','.sh','.py','.r','.tex','.yaml','.yml','.json'}
MAX=32*1024*1024

def run(root,out):
 root=Path(root).expanduser().resolve();out=Path(out);out.mkdir(parents=True,exist_ok=True)
 counts=collections.Counter();n=0;refs=set();manifests={}
 # Inventory references first; do not deduce duplicate revisions from identical prose.
 for p in sorted((root/'.history/revisions').rglob('*.json')):
  if p.is_symlink():continue
  try:
   d=json.loads(p.read_text());files=d.get('files',[])
   if isinstance(files,list):refs.update(x.get('blob') for x in files if isinstance(x,dict))
   manifests[str(p)]=d
  except (OSError,ValueError):pass
 with (out/'files.jsonl').open('x') as ledger,(out/'sections.jsonl').open('x') as sections:
  for base,dirs,files in os.walk(root,followlinks=False):
   for name in dirs[:]:
    p=Path(base)/name
    if p.is_symlink():dirs.remove(name);ledger.write(json.dumps({'path':str(p),'outcome':'symlink-directory-excluded'})+'\n');counts['symlink-directory-excluded']+=1
   dirs.sort()
   for name in sorted(files):
    p=Path(base)/name;rel=p.relative_to(root);parts=rel.parts;result={'path':str(p),'relative_path':str(rel),'placement':'archive' if 'archive' in parts else 'history' if '.history' in parts else 'active'}
    outcome='';size=0
    try:
     if p.is_symlink():outcome='symlink-excluded'
     else:
      size=p.stat().st_size;result['bytes']=size
      if '.cache' in parts or '__pycache__' in parts:outcome='cache-artifact'
      elif p.suffix=='.lock':outcome='runtime-lock'
      elif size>MAX:outcome='oversized-unparsed'
      else:
       raw=p.read_bytes();sha=hashlib.sha256(raw).hexdigest();result['sha256']=sha
       if 'blobs' in parts:
        result['referenced']=name in refs;outcome='referenced-blob' if name in refs else 'orphan-blob'
        if sha!=name:outcome='blob-hash-mismatch'
       elif 'heads' in parts:outcome='revision-head'
       elif str(p) in manifests:outcome='revision-manifest'
       elif 'revisions' in parts:outcome='invalid-revision-manifest'
       elif name in ('.curator_state','config.yaml','curator-state.json'):outcome='runtime-metadata'
       elif p.suffix.lower() in TEXT:
        # Vault-named documentation is not a credential store. Sanitize content;
        # exclude actual credential containers, never execute scripts.
        if p.suffix.lower() in ('.json','.yaml','.yml') and any(s in name.lower() for s in ('credentials','secrets','.env')):outcome='credential-container-excluded'
        else:
         text=raw.decode('utf8');outcome='parsed-text'
         for sec in markdown_sections(text):
          for chunk in section_chunks(sec):
           row={**result,'kind':'skill_support' if name!='SKILL.md' else 'skill_body','heading':redact(sec['heading']),'ancestry':[redact(v) for v in sec['ancestry']],**chunk};sections.write(json.dumps(row,ensure_ascii=False)+'\n');n+=1
       else:outcome='binary-or-generated-artifact'
    except (OSError,UnicodeError,ValueError) as e:outcome='error:'+type(e).__name__
    result['outcome']=outcome;ledger.write(json.dumps(result)+'\n');counts[outcome]+=1
 summary={'root':str(root),'file_outcomes':dict(counts),'text_chunks':n,'all_source_files_mutated':False,'paid_calls':0,'coverage_claim':'all leaf files under root accounted; binary/generated/cache metadata not knowledge-parsed; revisions parsed by separate hash-checking pass','blocking_outcomes':['invalid-revision-manifest','orphan-blob','blob-hash-mismatch','oversized-unparsed']}
 (out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root');p.add_argument('out');a=p.parse_args();run(a.root,a.out)
