"""Allowlisted source snapshot: excludes credentials, runtime state and vendor."""
import hashlib, json, subprocess, tarfile
from pathlib import Path
root=Path.cwd()
out=root/'artifacts/task-question-benchmark/harbor-current.tar.gz'
files=subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z']).decode().split('\0')
allowed=[]
for name in sorted(set(files)):
 p=root/name
 if not name or not p.is_file() or p.is_symlink(): continue
 if name in {'package.json','package-lock.json','tsconfig.base.json','AGENTS.md'} or name.startswith(('packages/','.pi/extensions/','.pi/lib/','.pi/themes/')):
  if '/node_modules/' not in name and '/dist/' not in name: allowed.append(name)
with tarfile.open(out,'w:gz') as archive:
 for name in allowed: archive.add(root/name,arcname=name,recursive=False)
manifest={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in allowed}
out.with_suffix('.manifest.json').write_text(json.dumps(manifest,indent=2))
print(f'{len(allowed)} source files -> {out}')
