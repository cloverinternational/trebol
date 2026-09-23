"""Read-only hash-checked skill revision text extraction."""
import base64,hashlib,re
from pathlib import Path
from corpus_parse import markdown_sections,section_chunks,redact

def revision_records(data,manifest):
 manifest=Path(manifest);entries=data.get('files',[]);history=next((p for p in manifest.parents if p.name=='.history'),None)
 if history is None:raise ValueError('Missing history boundary')
 if isinstance(entries,dict):entries=[{'path':k,'blob':v} for k,v in entries.items()]
 if not isinstance(entries,list):raise ValueError('Unknown revision files shape')
 for item in entries:
  name=item.get('path','');blob=item.get('blob','');p=Path(name)
  if p.is_absolute() or '..' in p.parts:raise ValueError('Unsafe revision path')
  if p.suffix.lower() not in ('.md','.txt'):continue
  if any(x in name.lower() for x in ('credential','secret','token','vault','.env')):continue
  if not re.fullmatch('[a-f0-9]{64}',blob):raise ValueError('Invalid blob digest')
  embedded=data.get('blobs',{}).get(name)
  if embedded is not None:
   if not isinstance(embedded,str) or len(embedded)>44*1024*1024:raise ValueError('Oversized embedded blob')
   raw=base64.b64decode(embedded,validate=True)
  else:
   path=history/'blobs'/blob
   if path.is_symlink() or path.stat().st_size>32*1024*1024:raise ValueError('Unsafe or oversized blob')
   raw=path.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=blob:raise ValueError('Blob hash mismatch')
  for section in markdown_sections(raw.decode('utf8')):
   for chunk in section_chunks(section):yield {'kind':'skill_revision_section','revision_id':data.get('id'),'revision_parent':data.get('parent'),'revision_action':data.get('action'),'time':data.get('created_at',data.get('createdAt')),'skill':redact(str(data.get('skill',manifest.parent.name))),'revision_file':name,'blob_sha256':blob,'span_basis':'decoded revision file, not manifest','heading':redact(section['heading']),'ancestry':[redact(h) for h in section['ancestry']],'ownership':'unresolved',**chunk}
