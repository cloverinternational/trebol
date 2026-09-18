"""Canonical project mapping compatible with Pi memoryIdentity; no fuzzy merges.
Missing workspaces stay unresolved. An explicit alias file is operator evidence,
not an automatic same-name/remote inference. Never writes live memory.
"""
import argparse,hashlib,json,subprocess
from pathlib import Path

def identity(cwd):
 p=Path(cwd)
 if not p.is_absolute() or not p.is_dir():return {'status':'unresolved','reason':'missing_or_relative_workspace','original_cwd':str(cwd)}
 # Git commands are read-only, bounded, argv separated. Match existing TS identity.
 def git(*args):return subprocess.check_output(['git','-C',str(p),'rev-parse',*args],stderr=subprocess.DEVNULL,text=True,timeout=5).strip()
 try:
  common=Path(git('--git-common-dir'));repository=str((p/common).resolve() if not common.is_absolute() else common.resolve());worktree=str(Path(git('--show-toplevel')).resolve());kind='git'
 except (subprocess.SubprocessError,OSError):
  repository=worktree=str(p.resolve());kind='directory'
 digest=lambda s:hashlib.sha256(s.encode()).hexdigest()[:32]
 return {'status':'mapped','original_cwd':str(cwd),'target_cwd':str(p.resolve()),'identity_kind':kind,'repository':repository,'worktree':worktree,'repository_key':digest(repository),'worktree_key':digest(worktree)}

def build(manifest,aliases=None):
 aliases=aliases or {};cache={};rows=[]
 for f in manifest['files']:
  cwd=f.get('header',{}).get('cwd')
  if not isinstance(cwd,str):mapping={'status':'unresolved','reason':'missing_header_cwd'}
  else:
   target=aliases.get(cwd,cwd)
   if target not in cache:cache[target]=identity(target)
   mapping={**cache[target],'original_cwd':cwd,'alias_applied':target!=cwd}
  rows.append({'source_id':f['id'],'source_path':f['path'],'source_sha256':f.get('sha256'),'scan_status':f['status'],'mapping':mapping})
 return {'version':1,'identity_contract':'git-common-dir/worktree; realpaths; explicit aliases only','aliases':aliases,'rows':rows,'summary':{'files':len(rows),'mapped':sum(r['mapping']['status']=='mapped' for r in rows),'unresolved':sum(r['mapping']['status']!='mapped' for r in rows),'repositories':len({r['mapping'].get('repository_key') for r in rows if r['mapping']['status']=='mapped'})}}
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('scan',type=Path);a.add_argument('--aliases',type=Path);args=a.parse_args();p=args.scan/'manifest.json';raw=p.read_bytes();result=build(json.loads(raw),json.loads(args.aliases.read_text()) if args.aliases else None);result['scan_manifest_sha256']=hashlib.sha256(raw).hexdigest();out=args.scan/'project-map.json'
 if out.exists():raise SystemExit('Mapping already frozen; choose a new output run rather than overwrite')
 out.write_text(json.dumps(result,indent=2));print(json.dumps(result['summary']))
