import importlib.util,subprocess,tempfile,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('mapping',Path(__file__).with_name('project_mapping.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_missing_does_not_fall_back_to_current_repo(self):self.assertEqual(m.identity('/nonexistent-memory-project')['status'],'unresolved')
 def test_worktree_and_nested_paths_share_repo_not_worktree(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);repo=p/'repo';repo.mkdir()
   def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL)
   git('init');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','init');wt=p/'other';git('worktree','add','--detach',str(wt));(repo/'nested').mkdir()
   root=m.identity(str(repo));nested=m.identity(str(repo/'nested'));other=m.identity(str(wt))
   self.assertEqual(root['repository_key'],nested['repository_key']);self.assertEqual(root['repository_key'],other['repository_key']);self.assertNotEqual(root['worktree_key'],other['worktree_key'])
 def test_identical_directory_names_do_not_merge(self):
  with tempfile.TemporaryDirectory() as tmp:
   a=Path(tmp)/'a'/'same';b=Path(tmp)/'b'/'same';a.mkdir(parents=True);b.mkdir(parents=True)
   self.assertNotEqual(m.identity(str(a))['repository_key'],m.identity(str(b))['repository_key'])
 def test_explicit_alias_is_recorded(self):
  with tempfile.TemporaryDirectory() as tmp:
   x=m.build({'files':[{'id':'f','path':'source','status':'scanned','header':{'cwd':'/old'}}]}, {'/old':tmp})
   self.assertTrue(x['rows'][0]['mapping']['alias_applied']);self.assertEqual(x['summary']['mapped'],1)
if __name__=='__main__':unittest.main()
