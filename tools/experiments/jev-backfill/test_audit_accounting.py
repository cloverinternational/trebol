import json,tempfile,unittest
from pathlib import Path
from audit_accounting import audit
class Tests(unittest.TestCase):
 def test_counts_primary_reservations_including_failed_or_unfinished_calls(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);(p/'pilot').mkdir();(p/'review-jobs').mkdir()
   (p/'manifest.json').write_text(json.dumps({'counts':{'chunks':12},'files':[{'status':'scanned','counts':{'chunks':9}},{'status':'scanned-with-exceptions','counts':{'chunks':3}}]}))
   (p/'pilot/calls.jsonl').write_text('{}\n{}\n');(p/'review-jobs/reservations.jsonl').write_text('{}\n')
   (p/'pilot/a.result.json').write_text('{"status":"failed"}');(p/'pilot/summary.json').write_text('{"reserved_calls":0}')
   a=audit(p);self.assertEqual(a['jev_reserved'],2);self.assertEqual(a['jev_results'],1);self.assertEqual(a['reviewer_budget_used'],2);self.assertEqual(a['excluded_exception_chunks'],3);self.assertEqual(a['remaining_authorized_ceiling'],{'jev':98,'reviewers':8})
if __name__=='__main__':unittest.main()
