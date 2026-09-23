"""Read-only accounting from primary ledgers, not stale pilot summaries."""
import collections,json
from pathlib import Path

def audit(root):
 root=Path(root)
 def rows(p):
  return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]
 manifest=json.loads((root/'manifest.json').read_text())
 chunks=collections.Counter()
 for f in manifest['files']:chunks[f['status']]+=f.get('counts',{}).get('chunks',0)
 calls=rows(root/'pilot/calls.jsonl');reviews=rows(root/'review-jobs/reservations.jsonl')
 results=[json.loads(p.read_text()) for p in (root/'pilot').glob('*.result.json')]
 # review_staged.py explicitly reserves one earlier exploratory job outside ledger.
 used_reviews=1+len(reviews)
 return {'chunks_by_status':dict(chunks),'manifest_chunks':manifest['counts']['chunks'],
 'lineage_expected_chunks':chunks['scanned'],'excluded_exception_chunks':chunks['scanned-with-exceptions'],
 'jev_reserved':len(calls),'jev_results':len(results),'jev_result_statuses':dict(collections.Counter(r.get('status','unknown') for r in results)),
 'reviewer_reserved_in_ledger':len(reviews),'prior_exploratory_jobs':1,'reviewer_budget_used':used_reviews,
 'remaining_authorized_ceiling':{'jev':max(0,100-len(calls)),'reviewers':max(0,10-used_reviews)},
 'scope':'this staging run only; reservations count as spend; no new calls or live writes'}
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('root',type=Path);args=p.parse_args();print(json.dumps(audit(args.root),indent=2))
