/** One traced, isolated, real-model Pi session for the memory pilot.
 * - workspace: detached git worktree of this repo at a fixed commit (gitignored
 *   dist/ and node_modules linked from this checkout), so evidence spans resolve
 *   and the product under test is exactly that commit's extension pack.
 * - agent dir: the user's ~/.pi/agent linked entry-by-entry, except sessions/
 *   (isolated) and models.json (baseUrl rewritten to the recording proxy).
 * - memory: PI_SWARM_MEMORY_DIR=<memoryDir> (the arm's store).
 * Writes <out>/{events.jsonl,stderr.txt,trace/,session.jsonl,meta.json}.
 * Usage: node tools/pilot/run-session.mjs --out DIR --memory DIR --task TEXT
 *        [--commit SHA] [--model provider/id] [--timeout-s 900]
 *        [--product SHA]  pin the extension pack to SHA (own worktree, loaded as
 *                         the only package; project-local resources ignored via
 *                         --no-approve) so --commit only selects the code under work
 *        [--prompt FILE]  arm prompt saved as the active custom prompt in the
 *                         workspace; {{forge-body}} / {{workspace}} rendered by the
 *                         product's own swarm-prompt assembly for this workspace */
import {spawn,execFileSync} from 'node:child_process';import {realpathSync,mkdirSync,existsSync,readdirSync,symlinkSync,readFileSync,writeFileSync,copyFileSync,statSync} from 'node:fs';import {join,resolve,dirname} from 'node:path';import {homedir} from 'node:os';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {startProxy} from './trace-proxy.mjs';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const arg=(k,d)=>{const i=process.argv.indexOf(`--${k}`);return i>0?process.argv[i+1]:d;};
const product=arg('product'),promptFile=arg('prompt');
const out=resolve(arg('out')),task=arg('task'),commit=arg('commit',execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()),model=arg('model'),timeoutS=Number(arg('timeout-s',900));
if(!out||!task||!arg('memory'))throw new Error('need --out --memory --task');
mkdirSync(out,{recursive:true});mkdirSync(resolve(arg('memory')),{recursive:true,mode:0o700});
// The knowledge store rejects symlinked ancestors (macOS /tmp -> /private/tmp).
const memory=realpathSync(resolve(arg('memory')));
// 1. Workspace at the pinned commit (reused across runs of the same commit).
// One worktree per run: parallel runs must not race on checkout/clean.
const ws=join(realpathSync('/tmp'),'trebol-pilot-ws',`${commit.slice(0,12)}-${createHash('sha256').update(out).digest('hex').slice(0,8)}`);
if(!existsSync(join(ws,'.git'))){mkdirSync(dirname(ws),{recursive:true});execFileSync('git',['-C',repo,'worktree','add','--detach','-f',ws,commit],{stdio:'ignore'});
  symlinkSync(join(repo,'node_modules'),join(ws,'node_modules'));
  for(const layer of readdirSync(join(repo,'packages')))for(const pkg of readdirSync(join(repo,'packages',layer))){const d=join(repo,'packages',layer,pkg,'dist');if(existsSync(d)&&!existsSync(join(ws,'packages',layer,pkg,'dist')))symlinkSync(d,join(ws,'packages',layer,pkg,'dist'));}}
execFileSync('git',['-C',ws,'checkout','-q','--detach','-f',commit]);execFileSync('git',['-C',ws,'clean','-qfd','-e','node_modules','-e','dist']);
let productDir;
if(product){productDir=join(realpathSync('/tmp'),'trebol-pilot-ws',`product-${product.slice(0,12)}`);
  if(!existsSync(join(productDir,'.git'))){execFileSync('git',['-C',repo,'worktree','add','--detach','-f',productDir,product],{stdio:'ignore'});symlinkSync(join(repo,'node_modules'),join(productDir,'node_modules'));
    for(const layer of readdirSync(join(repo,'packages')))for(const pkg of readdirSync(join(repo,'packages',layer))){const d=join(repo,'packages',layer,pkg,'dist');if(existsSync(d)&&!existsSync(join(productDir,'packages',layer,pkg,'dist')))symlinkSync(d,join(productDir,'packages',layer,pkg,'dist'));}}}
let promptSha;
if(promptFile){let text=readFileSync(promptFile,'utf8');
  const {createJiti}=await import(join(repo,'node_modules/jiti/lib/jiti.mjs'));const jiti=createJiti(join(productDir??repo,'tools/x.mjs'));
  const sp=await jiti.import(join(productDir??repo,'extensions/swarm-prompt/extension.ts'));
  if(text.includes('{{forge-body}}')){const body=sp.assembleForgePrompt('',{cwd:ws,interactive:false,headlessForge:true,discoverContextFiles:false}).prompt;const i=body.indexOf('<swarmos_context>');text=text.replace('{{forge-body}}',(i>=0?body.slice(0,i):body).trimEnd());}
  text=text.replace('{{workspace}}',sp.renderWorkspaceContext(sp.resolveWorkspace(ws)));
  mkdirSync(join(ws,'.pi','config'),{recursive:true});const cfgPath=join(ws,'.pi','config','prompt-context.json');
  const cfg=existsSync(cfgPath)?JSON.parse(readFileSync(cfgPath,'utf8')):{version:1};cfg.prompts=[{name:'bench-arm',content:text}];cfg.activePrompt='bench-arm';writeFileSync(cfgPath,JSON.stringify(cfg,null,1));
  promptSha=createHash('sha256').update(text).digest('hex').slice(0,16);writeFileSync(join(out,'arm-prompt.md'),text);}
// 2. Agent dir with traced providers.
const real=join(homedir(),'.pi','agent'),agent=join(out,'agent');mkdirSync(join(agent,'sessions'),{recursive:true});
for(const e of readdirSync(real))if(!['sessions','models.json',...(product?['settings.json']:[])].includes(e)&&!existsSync(join(agent,e)))symlinkSync(join(real,e),join(agent,e));
if(product){const st=JSON.parse(readFileSync(join(real,'settings.json'),'utf8'));st.packages=[{source:productDir}];writeFileSync(join(agent,'settings.json'),JSON.stringify(st,null,1));}
const models=JSON.parse(readFileSync(join(real,'models.json'),'utf8')),proxies=[];
for(const [name,p] of Object.entries(models.providers)){const up=new URL(p.baseUrl);const srv=await startProxy(p.baseUrl,join(out,'trace',name));proxies.push(srv);p.baseUrl=`http://127.0.0.1:${srv.address().port}${up.pathname.replace(/\/$/,'')}`;}
writeFileSync(join(agent,'models.json'),JSON.stringify(models),{mode:0o600});
// 3. Run.
const args=[...(model?['--model',model]:[]),'--mode','json','--print',product?'--no-approve':'--approve','--',task];
const t0=Date.now();
const child=spawn('pi',args,{cwd:ws,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_SWARM_MEMORY_DIR:memory},stdio:['ignore','pipe','pipe']});
const ev=[],errb=[];child.stdout.on('data',b=>ev.push(b));child.stderr.on('data',b=>errb.push(b));
const timer=setTimeout(()=>child.kill('SIGTERM'),timeoutS*1000);
const code=await new Promise(r=>child.once('exit',(c,s)=>r(c??s)));clearTimeout(timer);
for(const p of proxies)p.close();
writeFileSync(join(out,'events.jsonl'),Buffer.concat(ev));writeFileSync(join(out,'stderr.txt'),Buffer.concat(errb));
const sessions=[];const walk=d=>{for(const e of readdirSync(d)){const f=join(d,e);statSync(f).isDirectory()?walk(f):f.endsWith('.jsonl')&&sessions.push(f);}};walk(join(agent,'sessions'));
if(sessions[0])copyFileSync(sessions[0],join(out,'session.jsonl'));
const meta={task,commit,model:model??'default',memory,workspace:ws,exit:code,seconds:(Date.now()-t0)/1000,sessions:sessions.length,product:product??null,promptFile:promptFile??null,promptSha:promptSha??null,taskSha:createHash('sha256').update(task).digest('hex').slice(0,16)};
writeFileSync(join(out,'meta.json'),JSON.stringify(meta,null,1));console.log(JSON.stringify(meta));
