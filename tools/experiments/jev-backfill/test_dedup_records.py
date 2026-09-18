import json,tempfile,unittest
from pathlib import Path
from dedup_records import run
class Tests(unittest.TestCase):
 def test_keeps_sources_and_all_occurrences(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);rows=[{'record_id':str(i),'source_path':source,'text':'fact','source_line':i} for i,source in enumerate(['a','a','b'])];(p/'in').write_text(''.join(json.dumps(r)+'\n' for r in rows));run(p/'in',p/'out');s=json.loads((p/'out/summary.json').read_text());self.assertEqual(s['unique_records'],2);self.assertEqual(len((p/'out/occurrences.jsonl').read_text().splitlines()),3)
