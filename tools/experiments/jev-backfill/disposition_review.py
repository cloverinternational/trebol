"""Export explicit human-readable review decisions and citation repair proposals.
Never writes memory records. Decisions are this reviewed batch, not an auto-classifier.
"""
import hashlib,json
from pathlib import Path
DECISIONS={
'f80ed3ef-a43d-48c3-9b54-daac8ec4bffe':('exclude','Namespace copy; retain original history, use default counterpart for review.'),
'a3f82824-9669-4910-ad1d-e0dadb4bf96b':('keep','Direct historical Trefoil intent; not current implementation.'),
'a1eef863-4938-4025-99d1-009ffce71209':('exclude','Namespace copy; use default counterpart.'),
'ee3ff408-5285-41c6-99e0-55679deae401':('keep','Linked Firefox question/answer supports narrow historical approval.'),
'd2b60c54-da4c-49a1-bb19-ab6ba639b1af':('exclude','Namespace copy and one-time historical goal.'),
'0cc40005-82a9-4188-969d-6452cbe9d66a':('exclude','Historical task request, not useful durable current knowledge.'),
'd3417b02-e02e-43f6-9437-c1f9a5d3e5e1':('exclude','Assistant test/debugging diary; preserve in execution history.'),
'a14e407d-a3b6-44a2-aeba-95fd7f82acd7':('revise','Restore questionnaire context: historical global installation/multiple-account/UI preference, not OAuth-client selection or implementation proof.'),
'abcc637b-e64a-4705-a5bc-6a0b1e09208a':('exclude','Unverified third-party capabilities and obsolete setup investigation.'),
'2614734c-0dda-43aa-a497-05d53c4d2792':('revise','Useful contract; refresh outdated quote and current local scope/evidence before promotion.'),
'5b7485f9-d50a-4de0-8b4b-1d9e6873dc37':('revise','Useful code owner; record current code lines/hash and scope before promotion.'),
'c47fed20-d23b-4a7e-b3ba-93b2554ebd8c':('revise','Useful API contract; refresh exact code citation and local scope.'),
'c2bbd5e3-6f3b-45fb-8e5d-d04f6a4c91e5':('exclude','Branch/test/merge activity belongs in execution history.'),
'020db92b-550c-4eee-a799-5b460f3b1aed':('revise','MCP owner partly supported; remove uncertain adapter-activation assertions and consolidate with code-owner fact.')}
def build(root):
 root=Path(root).resolve();links={};current={}
 for jobfile in sorted((root/'review-jobs').glob('*/job.json')):
  job=json.loads(jobfile.read_text());p=jobfile.parent/'evidence-links.json'
  if hashlib.sha256(p.read_bytes()).hexdigest()!=job['evidence_links_sha256']:raise ValueError('Changed evidence links')
  if hashlib.sha256(Path(job['snapshot']).read_bytes()).hexdigest()!=job['snapshot_sha256']:raise ValueError('Changed snapshot')
  for link in json.loads(p.read_text()):
   locator={'snapshot_ref':str(jobfile.parent/'snapshot.jsonl')+'#'+link['snapshot_id'],'original_ref':link['source_file']+'#'+link['event_id'],'original_line':link['line'],'original_sha256_at_scan':link['source_sha256']}
   links.setdefault(link['snapshot_id'],[]).append(locator)
 for p in sorted((root/'staging-memory/knowledge').rglob('*.json')):
  event=json.loads(p.read_text());r=event['record'];current[(str(p.parent),r['namespace'],r['id'])]=r
 output=[]
 for r in current.values():
  if r.get('deleted'):continue
  decision,reason=DECISIONS.get(r['id'],('unreviewed','No manual decision; do not promote.'))
  citations=[]
  for e in r['evidence']:
   ref=e['ref'];matches=links.get(ref.split('#')[-1],[])
   if '#' in ref:matches=[m for m in matches if m['snapshot_ref']==ref]
   unique={json.dumps(m,sort_keys=True):m for m in matches};matches=list(unique.values())
   citations.append({'old_ref':ref,'resolution':'unique' if len(matches)==1 else 'ambiguous' if matches else 'code-or-unresolved','proposal':matches[0] if len(matches)==1 else None})
  output.append({'id':r['id'],'revision':r['revision'],'scope':r['scope'],'namespace':r['namespace'],'disposition':decision,'reason':reason,'citation_repairs':citations})
 return {'version':1,'applied':False,'live_writes':0,'records':output}
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('root',type=Path);args=p.parse_args();print(json.dumps(build(args.root),indent=2))
