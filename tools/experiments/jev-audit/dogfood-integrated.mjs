#!/usr/bin/env node
/** Real provider/Jev; existing provider auth, isolated project/memory/skills. */
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
if(!process.env.TYPESAFE_API_KEY)throw Error('TYPESAFE_API_KEY missing');
const root=join(repo,'artifacts/jev-audit',`integrated-${Date.now()}`),workspace=join(root,'workspace'),session=join(root,'parent.jsonl');await mkdir(workspace,{recursive:true});await mkdir(join(workspace,'.git'));await mkdir(join(root,'skills'));
await writeFile(join(workspace,'facts.md'),'# Project fixture\nAurora stores invoices in PostgreSQL.\nDeployment has NOT been tested; do not claim production readiness.\n');
const fixture=join(root,'enable.ts');await writeFile(fixture,`export default function(pi:any){pi.on("session_start",(_e:any,ctx:any)=>{pi.appendEntry("pi-swarm-memory-maintenance",{version:1,enabled:true,status:"idle",queue:[],done:[]});});}`);
// A valid seeded session enables worker through its persisted contract before startup.
const now=new Date().toISOString();await writeFile(session,[{type:'session',version:3,id:'integrated-parent',timestamp:now,cwd:workspace},{type:'custom',id:'worker-config',parentId:null,timestamp:now,customType:'pi-swarm-memory-maintenance',data:{version:1,enabled:true,status:'idle',queue:[],done:[]}}].map(JSON.stringify).join('\n')+'\n');
const prompt='Dogfood this isolated project. Read facts.md, create a small task for documenting database choice, write NOTES.md with that fact and an explicit untested-deployment caveat, then verify its contents. Use available project memory query. Do not access credentials, external services, or paths outside this workspace. Do not declare production readiness. End normally; background maintenance is host-owned.';
const args=['--model','clover-plexus/astra','--session',session,'--mode','json','--print','--approve','--',prompt];
const env={...process.env,PI_SWARM_JEV_AUDIT:'on',PI_SWARM_JEV_SUPERVISOR:'on',PI_SWARM_SUPERVISOR_TASK_APPLY:'on',PI_SWARM_MEMORY_DIR:join(root,'memory'),SWARM_AUTOGEN_DIR:join(root,'skills'),SWARM_AUTOGEN_MODE:'manual',PI_SWARM_SUBAGENT:'0',PI_SWARM_MEMORY_CAPTURE:'off'};
const child=spawn('pi',args,{cwd:workspace,env,detached:true,stdio:['ignore','pipe','pipe']});const stdout=[],stderr=[];child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));let timedOut=false;
const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},180000);
const exit=await new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',(code,signal)=>ok({code,signal}));});clearTimeout(timer);
await writeFile(join(root,'stdout.jsonl'),Buffer.concat(stdout));await writeFile(join(root,'stderr.txt'),Buffer.concat(stderr));
const entries=(await readFile(session,'utf8')).split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return {}}});
const audit=entries.filter(e=>e.customType==='pi-swarm-jev-audit').map(e=>e.data);const maintenance=entries.filter(e=>e.customType==='pi-swarm-memory-maintenance').map(e=>e.data);
const notes=await readFile(join(workspace,'NOTES.md'),'utf8').catch(()=>null);
const proof={root,exit,timedOut,auditEntries:audit.length,auditLast:audit.at(-1)?.status,workerEntries:maintenance.length,workerLast:maintenance.at(-1)?.status,notesExists:notes!==null,notesMentionPostgres:!!notes?.includes('PostgreSQL'),notesMentionUntested:!!notes&&/untested|not.*test/i.test(notes),unscripted:true};
await writeFile(join(root,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
