/** Calls the real swarm-prompt before_agent_start hook (headless and
 * interactive) with a given base prompt and reports which base won.
 * --warm simulates a session past the hook warm-up turns.
 * Usage: node tools/pilot/probe-prompt.mjs BASE_PROMPT_FILE [cwd] [--warm] */
import {createJiti} from 'jiti';import {readFileSync} from 'node:fs';
const jiti=createJiti(import.meta.url);
const {registerSwarmPrompt}=await jiti.import('../../extensions/swarm-prompt/extension.ts');
const base=readFileSync(process.argv[2],'utf8'),cwd=process.argv.slice(3).find(a=>!a.startsWith('--'))??process.cwd();
const warm=process.argv.includes('--warm');
if(warm)(globalThis[Symbol.for('pi-swarm-hook-turn-counts')]??=new Map()).set('session',99);
for(const hasUI of [false,true]){
  const handlers=[];const pi={on:(e,h)=>e==='before_agent_start'&&handlers.push(h),registerCommand(){},registerTool(){},events:{on(){},emit(){}}};
  registerSwarmPrompt(pi);
  let out;try{out=await handlers.at(-1)({systemPrompt:base,prompt:'x',systemPromptOptions:{cwd}},{cwd,hasUI});}catch(e){out={error:String(e).slice(0,300)};}
  const s=out?.systemPrompt??'';
  console.log(JSON.stringify({hasUI,handlers:handlers.length,returned:out===undefined?'undefined':Object.keys(out),chars:s.length,forge:s.includes('# Delegation (the Task tool)'),piBase:s.startsWith('You are an expert coding assistant operating inside pi'),error:out?.error}));
}
