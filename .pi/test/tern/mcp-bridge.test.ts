import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {it,expect,vi} from 'vitest';
import {PiTernBridge} from '../../lib/tern/bridge.ts';
import {publishMcpStatus,clearMcpStatus} from '../../lib/tools/mcp-status.ts';
import {parseTspMessages} from '../../lib/tern/tsp.ts';

// The startup card only draws its MCP row once the repository read has settled,
// and only for a git repository: until then infoNodes returns the
// "Reading repository…" (or non-git) placeholder and a status change produces no
// frame at all. Use a throwaway git workspace and wait for the card to settle
// instead of sleeping 250ms, so the assertion does not depend on how fast the
// host repository answers git.
const workspace = () => {
	const dir = mkdtempSync(join(tmpdir(), 'tern-mcp-'));
	execFileSync('git', ['init', '-q', dir]);
	execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial']);
	return dir;
};

/** The surface as Tern holds it: ops applied in order, so a node an early frame
 * added and a later frame deleted is seen as deleted. */
const tree = (writes: string[]) => {
	const nodes = new Map<string, unknown>();
	for (const w of writes) for (const m of parseTspMessages(w)) for (const op of ((m.body as { ops?: unknown[][] }).ops ?? [])) {
		if (op[0] === 'add') nodes.set(String(op[1]), op[4]);
		if (op[0] === 'del') nodes.delete(String(op[1]));
		if (op[0] === 'set') nodes.set(String(op[1]), { ...(nodes.get(String(op[1])) as object ?? {}), ...(op[2] as object) });
	}
	return nodes;
};
const drawn = (writes: string[]) => JSON.stringify([...tree(writes)]);

it('updates MCP status without a Pi event and isolates replacement sessions',async()=>{
 const cwd = workspace();
 const owner={}, writes:string[]=[];
 const session=(id:string):any=>({sessionManager:{getSessionId:()=>id,getCwd:()=>cwd,getEntries:()=>[],getBranch:()=>[]},subscribe:()=>()=>{},prompt:async()=>{},abort:async()=>{},dispose(){}});
 const bridge=new PiTernBridge(session('a'),{write:d=>writes.push(d),credits:1000});
 try {
  bridge.start('test');
  // tern-startup-header is drawn only for a settled git card, i.e. together with the MCP row.
  await vi.waitFor(() => expect(tree(writes).has('tern-startup-header')).toBe(true));
  writes.length=0;
  publishMcpStatus(owner,['proof'],'a');expect(drawn(writes)).toContain('proof');
  writes.length=0;publishMcpStatus(owner,[],'a');expect(drawn(writes)).toContain('No MCP servers connected');
  bridge.rebind(session('b'));expect(drawn(writes)).toContain('MCP status unavailable');
  writes.length=0;publishMcpStatus(owner,['other'],'a');expect(drawn(writes)).not.toContain('other');
  bridge.close();writes.length=0;clearMcpStatus(owner);expect(writes).toEqual([]);
 } finally{bridge.close();clearMcpStatus(owner);rmSync(cwd,{recursive:true,force:true});}
});
