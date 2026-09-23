import tempfile,json,unittest
from pathlib import Path
from summarize_cleanup_run import summarize
class Tests(unittest.TestCase):
 def test_labels_never_authorize_mutation(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);(p/'plan.json').write_text(json.dumps({'eligibleChunks':2,'exclusions':[]}));(p/('a'*64+'.json')).write_text(json.dumps({'status':'completed','findings':[{'category':'memory','confidence':.9,'id':'one'}],'sources':[{'path':'skill.md'}]}));(p/('b'*64+'.json')).write_text('{"status":"failed"}')
   summarize(p);q=json.loads((p/'cleanup-queue.jsonl').read_text());self.assertTrue(q['review_required']);self.assertFalse(q['applied']);self.assertEqual(q['proposed_action'],'verify-project-memory');self.assertEqual(json.loads((p/'summary.json').read_text())['failed_batches'],1)
