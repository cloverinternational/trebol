import json,tempfile,unittest
from pathlib import Path
from skill_coverage import run
class Tests(unittest.TestCase):
 def test_vault_documentation_is_parsed_but_secrets_container_is_not(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t)/'skills';root.mkdir();(root/'vault-guide.md').write_text('# Guide\nUse credential references, not values.\n');(root/'credentials.json').write_text('{"secret":"dont-export"}');out=Path(t)/'out';run(root,out)
   rows=[json.loads(l) for l in (out/'files.jsonl').read_text().splitlines()];self.assertEqual({r['outcome'] for r in rows},{'parsed-text','credential-container-excluded'});self.assertNotIn('dont-export',(out/'sections.jsonl').read_text())
