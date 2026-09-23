import base64,hashlib,tempfile,unittest
from pathlib import Path
from revision_extract import revision_records
class Tests(unittest.TestCase):
 def test_embedded_and_external_provenance(self):
  with tempfile.TemporaryDirectory() as t:
   h=Path(t)/'.history';(h/'blobs').mkdir(parents=True);p=h/'revisions'/'skill'/'x.json'
   raw=b'# Fact\nProject fact\n';sha=hashlib.sha256(raw).hexdigest();(h/'blobs'/sha).write_bytes(raw)
   a=list(revision_records({'files':[{'path':'SKILL.md','blob':sha}]},p));self.assertEqual(a[0]['blob_sha256'],sha)
   b=list(revision_records({'files':{'SKILL.md':sha},'blobs':{'SKILL.md':base64.b64encode(raw).decode()}},p));self.assertEqual(a[0]['text'],b[0]['text'])
   with self.assertRaises(ValueError):list(revision_records({'files':{'../SKILL.md':sha}},p))
   with self.assertRaises(ValueError):list(revision_records({'files':{'SKILL.md':'0'*64},'blobs':{'SKILL.md':base64.b64encode(raw).decode()}},p))
