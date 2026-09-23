import importlib.util,json,tempfile,unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import review_staged as r
class Tests(unittest.TestCase):
 def test_containment(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);self.assertEqual(r.contained(root/'file',root),root/'file')
   with self.assertRaises(ValueError):r.contained(root/'../outside',root)
 def test_snapshot_tamper_before_spawn(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);p=root/'snapshot.jsonl';p.write_text('changed')
   with self.assertRaisesRegex(ValueError,'Snapshot changed'):r.run_job({'snapshot':str(p),'snapshot_sha256':'bad'},root,'unused')
 def test_manifest_tamper(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);(root/'project-map.json').write_text(json.dumps({'scan_manifest_sha256':'bad'}));(root/'manifest.json').write_text('{}')
   with self.assertRaisesRegex(ValueError,'manifest changed'):r.prepare(root)
if __name__=='__main__':unittest.main()
