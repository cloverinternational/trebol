import importlib.util,json,tempfile,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('cp',Path(__file__).with_name('corpus_parse.py')); cp=importlib.util.module_from_spec(s); s.loader.exec_module(cp)
class T(unittest.TestCase):
 def test_sections(self):
  x=cp.markdown_sections('---\nx: y\n---\n# One\na\n```\n# no\n```\n## Two\nb\n'); self.assertEqual([z['heading'] for z in x],['One','Two']); self.assertEqual(x[0]['start_line'],4); self.assertEqual(x[0]['end_line'],8)
 def test_bounds_redact(self): self.assertTrue(all(len(x)<=4000 for x in cp.chunks('x'*9001))); self.assertNotIn('sk-testsecretvalue1234',cp.redact('sk-testsecretvalue1234'))
 def test_identity(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'task.json'; p.write_text(json.dumps({'conversationId':'c','tasks':[{'id':'t1','status':'completed','description':'hello'}]})); rows,e=cp.parse_task({'path':str(p),'sha256':'h'}); self.assertIsNone(e); self.assertEqual(rows[0]['task_id'],'t1'); self.assertTrue(rows[0]['json_pointer'].endswith('/description'))
if __name__=='__main__': unittest.main()

class Provenance(unittest.TestCase):
 def test_fences_ancestry_preamble_and_offsets(self):
  text='Intro\n# Parent\n````py\n```\n# not heading\n````\n## Child\n'+'x'*8001
  sections=cp.markdown_sections(text)
  self.assertEqual([s['heading'] for s in sections],['Preamble','Parent','Child'])
  self.assertEqual(sections[-1]['ancestry'],['Parent','Child'])
  for section in sections:
   for chunk in cp.section_chunks(section):
    self.assertEqual(text[chunk['start_offset']:chunk['end_offset']],chunk['text'])
    self.assertLessEqual(len(chunk['text']),4000)
