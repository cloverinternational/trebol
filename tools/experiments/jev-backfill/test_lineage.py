import json,tempfile,unittest
from pathlib import Path
from lineage import build
class Tests(unittest.TestCase):
 def test_only_proven_same_project_ancestor_deduplicates(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);files=[];maps=[]
   for name,parent,repo in [('a',None,'r'),('b',str(root/'a.jsonl'),'r'),('c',None,'r'),('d',str(root/'a.jsonl'),'other')]:
    events=root/(name+'.events.jsonl');events.write_text(json.dumps({'event_id':'e','parent_id':None,'chunk':0,'sha256':'same'})+'\n')
    files.append({'id':name,'path':str(root/(name+'.jsonl')),'events':str(events),'status':'scanned','header':{'parentSession':parent}});maps.append({'source_id':name,'mapping':{'status':'mapped','repository_key':repo}})
   (root/'manifest.json').write_text(json.dumps({'files':files}));(root/'project-map.json').write_text(json.dumps({'rows':maps}));result=build(root)
   self.assertEqual(result['proven_duplicate_chunks'],1);self.assertEqual(result['retained_chunks'],3);self.assertEqual(result['unresolved_parent_links'],1)
if __name__=='__main__':unittest.main()
