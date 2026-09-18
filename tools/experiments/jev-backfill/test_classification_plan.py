import tempfile,unittest
from pathlib import Path
from classification_plan import Record,ReservationLedger,plan,BudgetExhausted,batch_id
class Tests(unittest.TestCase):
 def test_budget_context_and_repeat(self):
  with tempfile.TemporaryDirectory() as t:
   ledger=ReservationLedger(Path(t)/'ledger.jsonl');r=Record('1','hash','claim',task_status='completed',task_subject='Goal')
   self.assertEqual(plan([r],prompt_version='v1',model='jev')['reservation'],'not_reserved')
   with self.assertRaises(ValueError):plan([r],prompt_version='v1',model='jev',ledger=ledger,dry_run=False)
   self.assertTrue(ledger.reserve('a',cap=100,legacy_reserved=99));ledger.mark('a','failed')
   self.assertFalse(ledger.reserve('a',cap=100,legacy_reserved=99))
   with self.assertRaises(BudgetExhausted):ledger.reserve('b',cap=100,legacy_reserved=99)
   with self.assertRaises(BudgetExhausted):ledger.reserve('review',cap=100,reviewer=True,reviewer_cap=10,legacy_reviewers=10)
   self.assertNotEqual(batch_id([r],'v1','jev'),batch_id([Record('1','hash','claim',task_status='pending')],'v1','jev'))
