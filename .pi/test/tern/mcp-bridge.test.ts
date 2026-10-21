import {it,expect} from 'vitest';
import {PiTernBridge} from '../../lib/tern/bridge.ts';
import {publishMcpStatus,clearMcpStatus} from '../../lib/tools/mcp-status.ts';
it('updates MCP status without a Pi event and isolates replacement sessions',async()=>{
 const owner={}, writes:string[]=[];
 const session=(id:string):any=>({sessionManager:{getSessionId:()=>id,getCwd:()=>process.cwd(),getEntries:()=>[],getBranch:()=>[]},subscribe:()=>()=>{},prompt:async()=>{},abort:async()=>{},dispose(){}});
 const bridge=new PiTernBridge(session('a'),{write:d=>writes.push(d),credits:1000});
 try {bridge.start('test'); await new Promise(r=>setTimeout(r,250));writes.length=0;
 publishMcpStatus(owner,['proof'],'a');expect(writes.join('')).toContain('proof');
 writes.length=0;publishMcpStatus(owner,[],'a');expect(writes.join('')).toContain('No MCP servers connected');
 bridge.rebind(session('b'));expect(writes.join('')).toContain('MCP status unavailable');
 writes.length=0;publishMcpStatus(owner,['other'],'a');expect(writes.join('')).not.toContain('other');
 bridge.close();writes.length=0;clearMcpStatus(owner);expect(writes).toEqual([]);
 }finally{bridge.close();clearMcpStatus(owner);}
});
