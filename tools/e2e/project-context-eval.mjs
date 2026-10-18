/** E2E: sealed project_context eval reproduces from its sealed inputs.
 * 1. Every hash in SEAL-queries/SEAL-runs/SEAL-qrels matches the files on disk.
 * 2. Re-running scoring/score.py on the three qrel sets reproduces scoring/scores.txt byte-for-byte.
 * 3. A/B downstream scores (ab/ab-scores*.txt) reproduce from the raw pi event logs in ab/runs.
 * 4. Near miss: one flipped grade in a temp copy of qrels changes the table (the check is not vacuous).
 * Needs artifacts/memory-audit/.venv with ranx+numpy (artifacts/ is local, gitignored except sealed files). */
import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';import {createHash} from 'node:crypto';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));const mem=join(root,'artifacts/memory-audit');const ev=join(mem,'eval');const py=join(mem,'.venv/bin/python');
const fail=m=>{console.error('FAIL',m);process.exit(1)};
if(!existsSync(py))fail('missing '+py+' (python3 -m venv artifacts/memory-audit/.venv && pip install ranx numpy)');
let n=0;for(const [seal,base] of [['SEAL-queries.txt',ev],['SEAL-runs.txt',ev],['SEAL-qrels.txt',mem]]){
  for(const line of readFileSync(join(ev,seal),'utf8').split('\n')){const m=/^([0-9a-f]{64})\s+(\S+)/.exec(line);if(!m)continue;
    const p=join(base,m[2]);if(!existsSync(p)){if(m[2]==='raw-events.jsonl')continue;fail('missing sealed file '+m[2])}
    const h=createHash('sha256').update(readFileSync(p)).digest('hex');
    if(h!==m[1]&&m[2]==='scoring/score.py'){ // documented post-seal amendment: sealed version must be in git and differ only by score-post-seal.diff
      const sealed=execFileSync('git',['show','8a33d6f:artifacts/memory-audit/scoring/score.py'],{cwd:root});
      if(createHash('sha256').update(sealed).digest('hex')!==m[1])fail('sealed scorer not recoverable from 8a33d6f');
      const d=execFileSync('git',['diff','8a33d6f','--','artifacts/memory-audit/scoring/score.py'],{cwd:root,encoding:'utf8'});
      const rec=readFileSync(join(mem,'scoring/score-post-seal.diff'),'utf8');const body=x=>x.split('\n').filter(l=>/^[+-][^+-]/.test(l)).join('\n');
      if(body(d)!==body(rec))fail('scorer changed beyond the recorded post-seal diff');console.log('seal: score.py = sealed 8a33d6f + recorded diff only');n++;continue}
    if(h!==m[1])fail(`hash mismatch ${seal}: ${m[2]}`);n++}}
console.log(`seal: ${n} hashes match`);
const score=q=>execFileSync(py,['scoring/score.py',q],{cwd:mem,encoding:'utf8',stdio:['ignore','pipe','ignore']});
const out=['qrels.jsonl','qrels-strict.jsonl','qrels-lenient.jsonl'].map(q=>score(q)+'\n').join('');
const want=readFileSync(join(mem,'scoring/scores.txt'),'utf8');
if(out!==want)fail('scores.txt not reproduced');console.log('reproduce: scores.txt identical ('+want.split('\n').length+' lines)');
const q=join(ev,'qrels.jsonl'),bak=q+'.e2e-bak';copyFileSync(q,bak);
try{const L=readFileSync(q,'utf8').trim().split('\n').map(JSON.parse);const i=L.findIndex(x=>x.grade===2);L[i].grade=0;writeFileSync(q,L.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const nm=score('qrels.jsonl');if(want.startsWith(nm))fail('near miss: flipped grade did not change output');console.log('near miss: flipped grade changes the table');}
finally{copyFileSync(bak,q);rmSync(bak);rmSync(join(ev,'per-query-scores.json'),{force:true});score('qrels.jsonl');}
const h2=createHash('sha256').update(readFileSync(q)).digest('hex');if(!readFileSync(join(ev,'SEAL-qrels.txt'),'utf8').includes(h2))fail('qrels not restored');
for(const [scr,txt] of [['ab/score_ab.py','ab/ab-scores.txt'],['ab/score_ab_F.py','ab/ab-scores-F.txt']]){
  const o=execFileSync('python3',[join(mem,scr)],{cwd:root,encoding:'utf8'});if(o!==readFileSync(join(mem,txt),'utf8'))fail(txt+' not reproduced from ab/runs');}
console.log('reproduce: A/B scores identical from raw pi runs');
console.log('PASS');
