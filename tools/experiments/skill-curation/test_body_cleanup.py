import json,tempfile,unittest
from pathlib import Path
from body_cleanup import plan,preview,verify
class Tests(unittest.TestCase):
 def test_repeatable_multisection_roundtrip(self):
  with tempfile.TemporaryDirectory() as t:
   r=Path(t);skill=r/'skills'/'example';skill.mkdir(parents=True);source=skill/'SKILL.md';raw='# Skill\nIntro\n## One\nHistory\n### Nested\nKeep obligation\n## Two\nOther history\n';source.write_text(raw)
   a=plan(r/'skills',None,r/'plan');self.assertEqual(a,plan(r/'skills',None,r/'plan'))
   decisions=[{'id':s['id'],'action':'split','reviewed':True,'reviewer':'test','rationale':'fixture','procedure':'## '+s['heading']+'\nMethod'} for s in a['skills'][0]['sections']];d=r/'decisions.json';d.write_text(json.dumps(decisions))
   preview(r/'plan/plan.json',d,r/'out');self.assertTrue(verify(r/'out/example'));self.assertTrue(preview(r/'plan/plan.json',d,r/'out')[0]['reused']);self.assertEqual(source.read_text(),raw)
   source.write_text(raw+'changed')
   with self.assertRaises(ValueError):preview(r/'plan/plan.json',d,r/'out2')
 def test_unreviewed_refused(self):
  with tempfile.TemporaryDirectory() as t:
   r=Path(t);(r/'plan').write_text('{"skills":[]}');(r/'d').write_text('[{"action":"split","reviewed":false}]')
   with self.assertRaises(ValueError):preview(r/'plan',r/'d',r/'out')
