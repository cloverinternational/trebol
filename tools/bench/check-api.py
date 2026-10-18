"""For a fix commit: list symbols the fix-version test files import that the parent commit does not export
(or modules missing at the parent). Usage: check-api.py SHA..."""
import re,subprocess,sys,posixpath
def show(rev,path):
  r=subprocess.run(['git','show',f'{rev}:{path}'],capture_output=True,text=True);return r.stdout if r.returncode==0 else None
for c in sys.argv[1:]:
  tests=[t for t in subprocess.run(['git','show','--name-only','--format=',c],capture_output=True,text=True).stdout.split() if t.endswith('.test.ts')]
  missing=[]
  for t in tests:
    src=show(c,t) or ''
    for names,mod in re.findall(r'import\s*\{([^}]*)\}\s*from\s*["\']([^"\']+)["\']',src)+[('*',m) for m in re.findall(r'import\s+\w+\s+from\s*["\'](\.[^"\']+)["\']',src)]:
      if not mod.startswith('.'):continue
      p=posixpath.normpath(posixpath.join(posixpath.dirname(t),mod))
      cands=[p,re.sub(r'\.js$','.ts',p),p+'.ts',p+'/index.ts']
      body=next((b for b in (show(c+'^',x) for x in cands) if b is not None),None)
      if body is None:missing.append(f'module {p}');continue
      for n in [x.strip().split(' as ')[0].replace('type ','').strip() for x in names.split(',') if x.strip() and names!='*']:
        if not re.search(r'export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+'+re.escape(n)+r'\b|export\s*\{[^}]*\b'+re.escape(n)+r'\b',body):missing.append(n)
  print(c,'OK' if not missing else 'MISSING '+', '.join(sorted(set(missing))))
