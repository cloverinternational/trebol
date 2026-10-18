/** Behaviour analysis of one pilot run dir: tool-call timeline, errors, files
 * read (and repeats), recall surfaced vs. re-read, context size per model call,
 * memory store census. Usage: node tools/pilot/analyze.mjs RUN_DIR [--json] */
import {readFileSync,readdirSync,existsSync} from 'node:fs';import {join} from 'node:path';
const dir=process.argv[2],asJson=process.argv.includes('--json');
const lines=f=>existsSync(f)?readFileSync(f,'utf8').split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}}):[];
const S=lines(join(dir,'session.jsonl')),meta=JSON.parse(readFileSync(join(dir,'meta.json'),'utf8'));
const text=c=>typeof c==='string'?c:(c??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
const calls=[],results=new Map();
for(const e of S){if(e.type!=='message')continue;const m=e.message;
 if(m.role==='assistant')for(const p of m.content??[])if(p.type==='toolCall')calls.push({id:p.id,name:p.name,args:p.arguments});
 if(m.role==='toolResult')results.set(m.toolCallId,{isError:!!m.isError,text:text(m.content)});}
const fileOf=c=>{const a=c.args??{};if(c.name==='read')return a.path;const cmd=String(a.command??'');const m=cmd.match(/(?:cat|sed -n [^ ]+|nl -ba|head -n \d+|tail -n \d+)\s+([\w./-]+\.\w+)/);return m?.[1];};
const reads=calls.map(fileOf).filter(Boolean),readCount={};for(const f of reads)readCount[f]=(readCount[f]??0)+1;
const boot=calls.find(c=>c.name==='bootstrap'),bootRes=boot&&results.get(boot.id)?.text;
let surfaced=[];try{const j=JSON.parse(bootRes);surfaced=(j.memories??j.memory??[]).map(m=>({id:m.id,source:String(m.source??'').split(':')[0],text:String(m.text??'').slice(0,100)}));}catch{}
const traces=[];for(const p of existsSync(join(dir,'trace'))?readdirSync(join(dir,'trace')):[])for(const f of readdirSync(join(dir,'trace',p)).filter(f=>f.endsWith('.req.json'))){const b=JSON.parse(readFileSync(join(dir,'trace',p,f),'utf8')).body;const sys=typeof b.system==='string'?b.system:(b.system??[]).map(x=>x.text??'').join('');traces.push({f:`${p}/${f}`,model:b.model,sys:sys.length||JSON.stringify((b.messages??[]).filter(m=>m.role==='system')).length,tools:(b.tools??[]).length,toolChars:JSON.stringify(b.tools??[]).length,msgs:(b.messages??[]).length,msgChars:JSON.stringify(b.messages??[]).length});}
const lastAssistant=[...S].reverse().find(e=>e.type==='message'&&e.message.role==='assistant');
const r={run:dir,exit:meta.exit,seconds:meta.seconds,toolCalls:calls.length,errors:calls.filter(c=>results.get(c.id)?.isError).length,
 byTool:Object.fromEntries(Object.entries(calls.reduce((a,c)=>(a[c.name]=(a[c.name]??0)+1,a),{})).sort((a,b)=>b[1]-a[1])),
 distinctFilesRead:Object.keys(readCount).length,repeatReads:Object.values(readCount).reduce((a,n)=>a+n-1,0),asks:calls.filter(c=>/ask_user/.test(c.name)).length,
 bootstrapCalled:!!boot,surfaced,modelCalls:traces.length,contextChars:traces.map(t=>t.sys+t.toolChars+t.msgChars),
 final:text(lastAssistant?.message.content).slice(0,600)};
if(asJson){console.log(JSON.stringify(r));process.exit(0);}
console.log(JSON.stringify({...r,final:undefined,surfaced:r.surfaced.length},null,0));
for(const c of calls){const res=results.get(c.id);console.log(`${res?.isError?'ERR':'ok '} ${c.name.padEnd(16)} ${JSON.stringify(c.args).slice(0,150)}${res?.isError?'\n      -> '+res.text.slice(0,200).replace(/\n/g,' '):''}`);}
for(const s of r.surfaced)console.log('  surfaced',s.source,s.text);
console.log('FINAL:',r.final.replace(/\n/g,' ').slice(0,500));
