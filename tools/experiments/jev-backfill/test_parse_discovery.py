import json,tempfile,hashlib,unittest
from pathlib import Path
from parse_discovery import run
class Tests(unittest.TestCase):
 def test_created_and_lifecycle_have_explicit_receipts(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);items=[]
   for i,data in enumerate([{'event_type':'task.created','conversation_id':'c','payload':{'task_id':'7','fields':{'subject':'Fix cache','description':'Verify invalidation'}}},{'event_type':'task.field_changed','payload':{'field_name':'status','new_value':'completed'}}]):
    p=root/f'{i}.json';p.write_text(json.dumps(data));items.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size,'kind':'task-metadata','placement':'current','outcome':'candidate'})
   inv=root/'inventory';inv.write_text(''.join(json.dumps(i)+'\n' for i in items));run(inv,root/'out')
   receipts=[json.loads(l) for l in (root/'out/receipts.jsonl').read_text().splitlines()]
   self.assertEqual([r['outcome'] for r in receipts],['parsed','lifecycle-only-field'])
   records=[json.loads(l) for l in (root/'out/records.jsonl').read_text().splitlines()];self.assertEqual(records[0]['task_id'],'7');self.assertEqual(records[0]['kind'],'task_created_snapshot')
