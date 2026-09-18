import importlib.util,io,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('scanner',Path(__file__).with_name('scan.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_boundaries(self):
  rows=list(m.bounded_lines(io.BytesIO(b'123456789\nok\n'),4));self.assertTrue(rows[0][2]);self.assertEqual(rows[1][1],b'ok\n')
 def test_no_reasoning(self):self.assertEqual(m.extract({'content':[{'type':'thinking','thinking':'hidden'},{'type':'text','text':'visible'}]}),'visible')
 def test_redact(self):self.assertNotIn('apikey_abcdef123',m.redact('apikey_abcdef123'))
 def test_complete_resume_and_chunks(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);p=root/'.pi/agent/sessions/x/a.jsonl';p.parent.mkdir(parents=True)
   records=[{'type':'session','id':'s','cwd':str(root)},{'type':'message','id':'u','message':{'role':'user','content':'x'*4000}},{'type':'message','id':'tool','message':{'role':'toolResult','toolName':'Bash','content':'actual result'}}]
   p.write_text('\n'.join(json.dumps(x) for x in records)+'\ninvalid\n');out=root/'output';r=m.scan(root,out);self.assertEqual(r['counts']['malformed'],1);self.assertEqual(r['counts']['chunks'],4)
   rows=[json.loads(l) for l in next((out/'files').glob('*.events.jsonl')).read_text().splitlines()];self.assertEqual(''.join(x['text'] for x in rows if x['event_id']=='u'),'x'*4000)
   self.assertEqual(m.scan(root,out)['counts'],r['counts'])
if __name__=='__main__':unittest.main()
