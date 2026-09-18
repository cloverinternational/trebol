import hashlib, json, tempfile
from pathlib import Path
import pytest
from preview import build, reconstruct, SourceChanged

SOURCE=Path.home()/".swarm/skills/autogen/swarm-stack-engineering/SKILL.md"
def test_reconstruction_exact_and_metadata_links():
 with tempfile.TemporaryDirectory() as d:
  out=Path(d); m=build(SOURCE,out)
  original=SOURCE.read_bytes(); body=(out/'preview-body.md').read_bytes(); ref=(out/'preview-references-budget-ui-history.md').read_bytes()
  assert reconstruct(original,body,ref,m)==original
  assert body.startswith(b"---\n") and b"references/budget-ui-history.md" in body
  assert m["mutations"]==0 and m["source_sha256"]==hashlib.sha256(original).hexdigest()
  assert m["body_bytes"] < m["source_bytes"]

def test_unknown_source_change_rejected():
 with tempfile.TemporaryDirectory() as d:
  out=Path(d); m=build(SOURCE,out); changed=SOURCE.read_bytes()+b"\n"
  with pytest.raises(SourceChanged): reconstruct(changed,(out/'preview-body.md').read_bytes(),(out/'preview-references-budget-ui-history.md').read_bytes(),m)

def test_reference_is_stable_relative_link_and_only_approved_sections_moved():
 with tempfile.TemporaryDirectory() as d:
  out=Path(d); build(SOURCE,out)
  m=json.loads((out/'preview-manifest.json').read_text()); ref=(out/'preview-references-budget-ui-history.md').read_text()
  assert m['reference']=='references/budget-ui-history.md'
  assert '## Comparative CLI and agent-run analysis' not in ref
  assert '## Curator correction — revision-manifest decode failures' not in ref
  assert '## Runtime budget enforcement and UI exposure' not in ref

def test_modified_body_and_reference_rejected():
 with tempfile.TemporaryDirectory() as d:
  out=Path(d); m=build(SOURCE,out); original=SOURCE.read_bytes()
  body=(out/'preview-body.md').read_bytes(); ref=(out/'preview-references-budget-ui-history.md').read_bytes()
  with pytest.raises(SourceChanged): reconstruct(original,body+b"tampered",ref,m)
  with pytest.raises(SourceChanged): reconstruct(original,body,ref+b"tampered",m)
