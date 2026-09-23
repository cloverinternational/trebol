import json,tempfile,unittest
from pathlib import Path
from disposition_review import build
class Tests(unittest.TestCase):
 def test_unknown_record_stays_unreviewed_and_store_unchanged(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);store=root/'staging-memory/knowledge/repository/project';store.mkdir(parents=True)
   record={'id':'new','revision':'r','scope':'repository','namespace':'default','evidence':[{'ref':'unknown-0'}]}
   file=store/'1.json';file.write_text(json.dumps({'record':record}));before=file.read_bytes()
   report=build(root);self.assertFalse(report['applied']);self.assertEqual(report['records'][0]['disposition'],'unreviewed');self.assertEqual(report['records'][0]['citation_repairs'][0]['resolution'],'code-or-unresolved');self.assertEqual(file.read_bytes(),before)
if __name__=='__main__':unittest.main()
