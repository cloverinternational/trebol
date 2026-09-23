"""Explicitly reviewed batch decisions; not an automatic semantic classifier."""
import json,hashlib
from pathlib import Path
from safe_split import build,reconstruct
ROOT=Path('artifacts/jev-backfill/cleanup-batch-v1')
# Decisions derived from parent reading the flagged full sample excerpts.
DECISIONS={
'98408c39274c974d9c17beee':('split','Run behavior tests after dependency upgrades; inspect changed upstream semantics before fixing assertions. Never skip tests merely for green.','Historical MCP SDK version incident; needs project attribution.'),
'0d19178535ed03b607bcb76b':('retain','', 'Error-direction analysis and certificate verification are reusable methods; examples support the procedure.'),
'8f17d61ccb2d5a1c200161c0':('split','Verify the actual repository and patch target before edits. After an edit, inspect target git status and changed paths. Do not trust a remembered session root or a tool success message alone. Do not create throwaway files merely to discover the root.','Session-specific paths are not durable current configuration.'),
'40aa193406254f48823296a0':('retain','','LaTeX/ggplot layout remedies are procedures; do not migrate wholesale.'),
'15fa38971e2a626af0a34f2e':('split','Trace browser-to-worker reachability across host boundaries. Preserve loopback isolation; use an authenticated scoped reverse proxy rather than exposing worker runtimes publicly. Verify current routes and authorization before implementation.','Cloverwork source-path and port claims require current code validation.'),
'431367f5f79e1d70516fbf17':('split','Read verifier output per trial and report concrete defect mechanisms. Distinguish code defects, infrastructure faults and verifier-only requirements; passing visible unit tests does not establish full acceptance.','Historical benchmark outcomes belong in experiment history, not verified project facts.'),
'7b1bb084832537cab62ec7c4':('split','Compile package tests before claiming coverage. Separate known baseline failures from regressions using an isolated checkout. Do not weaken secret-redaction assertions without establishing intended behavior.','Old vault compilation and test failures are dated incident assertions.'),
'146e997fa0aaa0d5cece8115':('memory-review','','Specific scaffolder edit claim needs source/revision confirmation.'),
'42e4f584af92f75da21dfa8f':('memory-review','','Historical implementation map includes possibly outdated paths; retain until current owner/revision verified.'),
'ef575f861fa99f3d88a13e44':('retain','','403 interpretation is reusable investigative guidance, not unresolved project work.'),
'26f468f559323ea90962ee81':('memory-review','','Historical architecture contract; verify owning Swarm desktop/SDK revision.'),
'e3136894e02156f697a19899':('memory-review','','Old timeout diagnosis is not current runtime truth.'),
'478571f326ab6bcb53d30472':('memory-review','','Tangerix component behavior is project-specific; source not verified.'),
'aeb01891b037c4513e839ddc':('memory-review','','Cached-token accounting diagnosis and speculation require verification; not current provider state.')}
def run():
 out=ROOT/'reviewed';out.mkdir(exist_ok=True);records=[]
 for file in sorted(ROOT.glob('cleanup-*.json')):
  data=json.loads(file.read_text())
  for f,source in zip(data.get('result',{}).get('findings',[]),data.get('sources',[])):
   action,procedure,reason=DECISIONS.get(f['id'],('unreviewed','','Procedure-labelled control not independently reviewed; retain.'))
   row={'id':f['id'],'source':source,'jev_category':f['category'],'confidence':f['confidence'],'review_action':action,'reason':reason,'applied':False,'memory_status':'candidate only','publication_blockers':['fresh SkillManage revision','verified project ownership','independent no-loss review'] if action=='split' else []}
   if action=='split':
    p=Path(source['path']);raw=p.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=source['sha256']:raise ValueError('Source drift; re-review')
    # Offsets describe the actual sampled source span; no unreviewed adjacent content removed.
    preview=out/f['id'];body='# '+json.loads(f['evidence']['text'])['heading']+'\n\n'+procedure
    if not preview.exists():build(p,source['start'],source['end'],source['sha256'],body,preview)
    if reconstruct(preview)!=raw:raise ValueError('Lossless reconstruction failed')
    row['preview']=str(preview)
   records.append(row)
 (out/'decisions.json').write_text(json.dumps(records,indent=2));print(json.dumps({'reviewed':len(DECISIONS),'records':len(records),'split_previews':sum(r['review_action']=='split' for r in records),'sources_changed':0}))
if __name__=='__main__':run()
