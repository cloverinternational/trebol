/** Recording reverse proxy: forwards every provider request to UPSTREAM and
 * writes the exact request body (system prompt, tools, messages) and the raw
 * response stream to OUT/NNN.{req.json,res.txt}. Headers are never logged.
 * Point the client's baseUrl at http://127.0.0.1:<port><upstream path>.
 * Usage: node tools/pilot/trace-proxy.mjs <upstreamBaseUrl> <outDir> [port] */
import {createServer} from 'node:http';import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
export function startProxy(upstream,out,port=0){
  mkdirSync(out,{recursive:true});let n=0;const up=new URL(upstream);
  const server=createServer(async(req,res)=>{
    const id=String(++n).padStart(3,'0');let body='';for await(const c of req)body+=c;
    // Callers point baseUrl at proxy + upstream path, so req.url already carries it.
    const target=new URL(req.url,up.origin);
    writeFileSync(join(out,`${id}.req.json`),JSON.stringify({at:new Date().toISOString(),method:req.method,path:req.url,body:(()=>{try{return JSON.parse(body)}catch{return body}})()},null,1));
    const headers={...req.headers};delete headers.host;delete headers['content-length'];delete headers['accept-encoding'];
    const t0=Date.now();
    try{
      const r=await fetch(target,{method:req.method,headers,body:req.method==='GET'?undefined:body});
      res.writeHead(r.status,Object.fromEntries([...r.headers].filter(([k])=>!['content-encoding','content-length','transfer-encoding'].includes(k))));
      const file=join(out,`${id}.res.txt`);writeFileSync(file,'');
      for await(const chunk of r.body){appendFileSync(file,chunk);res.write(chunk);}
      res.end();appendFileSync(join(out,'index.jsonl'),JSON.stringify({id,status:r.status,ms:Date.now()-t0,path:req.url})+'\n');
    }catch(e){res.writeHead(502);res.end(String(e));appendFileSync(join(out,'index.jsonl'),JSON.stringify({id,error:String(e).slice(0,200)})+'\n');}
  });
  return new Promise(r=>server.listen(port,'127.0.0.1',()=>r(server)));
}
if(import.meta.url===`file://${process.argv[1]}`){const s=await startProxy(process.argv[2],process.argv[3],Number(process.argv[4]??0));console.log('proxy on',s.address().port);}
