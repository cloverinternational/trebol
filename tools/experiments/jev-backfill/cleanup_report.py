"""Readable per-skill classification index with explicit coverage and edit gates."""
import collections,json
from pathlib import Path

def report(root,coverage):
 root=Path(root);coverage=Path(coverage);groups={}
 for line in (root/'cleanup-queue.jsonl').open():
  r=json.loads(line);g=groups.setdefault(r['path'],{'counts':collections.Counter(),'findings':[]});g['counts'][r['category']]+=1;g['findings'].append(r)
 withheld=[];empty=0
 for line in (coverage/'sections.jsonl').open():
  r=json.loads(line)
  if not r['text'].strip():empty+=1
  elif '[OMITTED:' in r['text']:withheld.append({k:r[k] for k in ('path','sha256','start_offset','end_offset','heading')})
 (root/'local-sensitive-review.json').write_text(json.dumps({'network_allowed':False,'sections':withheld},indent=2))
 md=['# Skill cleanup review index','','Classification is a finder, not approval. No source edits or memory promotions.','',f'Files with classified chunks: {len(groups)}. Empty chunks: {empty}. Sensitive chunks held locally: {len(withheld)}.','','## Rules','- Procedure: retain pending validity review.','- Memory: confirm owning project, source evidence and current relevance before storing.','- Mixed: split only with preserved original, explicit load pointer and no-loss review.','- Noise/temporary: never auto-delete.','- No history/revision classification coverage is implied by this current-text run.','']
 for path,g in sorted(groups.items(),key=lambda kv:(-sum(v for k,v in kv[1]['counts'].items() if k!='procedure'),kv[0])):
  md += [f'## {path}',', '.join(f'{k}: {v}' for k,v in sorted(g['counts'].items())),'']
  for r in g['findings']:
   if r['category']!='procedure':md.append(f"- `{r['id']}` **{r['category']}** ({r['confidence']:.2f}): {r['heading']} — characters {r['start']}–{r['end']}; evidence/project review required.")
  md.append('')
 (root/'REVIEW.md').write_text('\n'.join(md)+'\n');return {'classified_files':len(groups),'empty_chunks':empty,'withheld_chunks':len(withheld)}
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('root');p.add_argument('coverage');a=p.parse_args();print(json.dumps(report(a.root,a.coverage)))
