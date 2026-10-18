/** Paired memory pilot. T1 runs once into memory store M (arm B seed). T2 then
 * runs --reps times per arm: A = empty store, B = copy of M. Writes every run
 * to OUT/<arm>-<rep>/ and a summary.json from analyze.mjs.
 * Usage: node tools/pilot/run-pair.mjs PAIR.json OUT [--reps 2] [--model p/id] */
import {execFileSync,spawn} from 'node:child_process';import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync} from 'node:fs';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
const pair=JSON.parse(readFileSync(process.argv[2],'utf8')),out=resolve(process.argv[3]);
const opt=(k,d)=>{const i=process.argv.indexOf(`--${k}`);return i>0?process.argv[i+1]:d;};
const reps=Number(opt('reps',2)),model=opt('model');
const session=(dir,mem,task)=>new Promise(r=>{const c=spawn('node',[join(here,'run-session.mjs'),'--out',dir,'--memory',mem,'--task',task,...(model?['--model',model]:[])],{stdio:'ignore'});c.once('exit',r);});
mkdirSync(out,{recursive:true});
if(!existsSync(join(out,'t1','meta.json')))await session(join(out,'t1'),join(out,'mem-t1'),pair.t1);
const runs=[];for(let i=1;i<=reps;i++)for(const arm of ['A','B']){const mem=join(out,`mem-${arm}-${i}`);if(arm==='B'&&!existsSync(mem))cpSync(join(out,'mem-t1'),mem,{recursive:true});runs.push([arm,i,session(join(out,`${arm}-${i}`),mem,pair.t2)]);}
await Promise.all(runs.map(r=>r[2]));
const analyze=d=>JSON.parse(execFileSync('node',[join(here,'analyze.mjs'),d,'--json','--seed',join(out,'mem-t1')],{encoding:'utf8'}));
const summary={pair:pair.id,t1:analyze(join(out,'t1')),t2:runs.map(([arm,i])=>({arm,rep:i,...analyze(join(out,`${arm}-${i}`))}))};
writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,1));
for(const r of summary.t2)console.log(`${r.arm}${r.rep} calls=${r.toolCalls} err=${r.errors} files=${r.distinctFilesRead} rereads=${r.repeatReads} memTools=${(r.byTool.memory_history??0)+(r.byTool.bootstrap??0)} surfaced=${r.surfaced.length} modelCalls=${r.modelCalls} maxCtx=${Math.max(...r.contextChars)} s=${r.seconds}`);
