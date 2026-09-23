"""Build a reversible preview. Never mutates skills or authorizes promotion."""
import hashlib,json
from pathlib import Path

def sha(b):return hashlib.sha256(b).hexdigest()
def build(source,start,end,expected_hash,procedure,out):
 source=Path(source);raw=source.read_bytes()
 if sha(raw)!=expected_hash:raise ValueError('Source changed; re-review')
 text=raw.decode();out=Path(out)
 if not (0<=start<end<=len(text)):raise ValueError('Invalid source span')
 preserved=text[start:end];name='preserved-'+sha(preserved.encode())[:16]+'.md'
 replacement=procedure.rstrip()+f'\n\nBefore acting on this topic, read [{name}]({name}) for the complete historical evidence and edge-case obligations. Historical claims are not current project facts; verify against the target repository before use.\n'
 preview=text[:start]+replacement+text[end:]
 out.mkdir(parents=True,exist_ok=False)
 (out/name).write_bytes(preserved.encode());(out/'preview.md').write_bytes(preview.encode())
 manifest={'source':str(source),'source_sha256':expected_hash,'start':start,'end':end,'replacement':replacement,'preserved_file':name,'preserved_sha256':sha(preserved.encode()),'preview_sha256':sha(preview.encode()),'applied':False,'memory_promotions':0,'publication_requires':['independent review','fresh SkillManage revision','support-file write before body mutation']}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2));return manifest

def reconstruct(out):
 out=Path(out);m=json.loads((out/'manifest.json').read_text());preview=(out/'preview.md').read_bytes();preserved=(out/m['preserved_file']).read_bytes()
 if sha(preview)!=m['preview_sha256'] or sha(preserved)!=m['preserved_sha256']:raise ValueError('Preview content changed')
 text=preview.decode();start=m['start'];replacement=m['replacement']
 if text[start:start+len(replacement)]!=replacement:raise ValueError('Replacement mismatch')
 original=(text[:start]+preserved.decode()+text[start+len(replacement):]).encode()
 if sha(original)!=m['source_sha256']:raise ValueError('Reconstruction mismatch')
 return original
