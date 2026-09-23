import tempfile,unittest
from pathlib import Path
from safe_split import build,reconstruct,sha
class Tests(unittest.TestCase):
 def test_roundtrip_and_no_mutation(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);source=p/'source.md';raw='Préface\n# Topic\nOld fact and instruction\n# End\nKeep\n'.encode();source.write_bytes(raw);text=raw.decode();out=p/'preview'
   build(source,text.index('# Topic'),text.index('# End'),sha(raw),'# Topic\nReusable method',out)
   self.assertEqual(reconstruct(out),raw);self.assertEqual(source.read_bytes(),raw)
   self.assertIn('Before acting',(out/'preview.md').read_text());(out/'preview.md').write_text('tampered')
   with self.assertRaises(ValueError):reconstruct(out)
 def test_stale_source_refused(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);s=p/'s';s.write_text('changed')
   with self.assertRaises(ValueError):build(s,0,2,'wrong','method',p/'out')
