import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openKnowledgeStore } from '../../lib/state/knowledge-store.ts';
import { recallKnowledge } from '../../lib/context/knowledge-recall.ts';
it('projects only current verified facts into scoped cited PageIndex reads', () => {
 const root=mkdtempSync(join(tmpdir(),'knowledge-recall-'));const cwd=join(root,'project');const storeRoot=join(root,'store');
 try {
  const store=openKnowledgeStore({cwd,root:storeRoot});
  expect(recallKnowledge(cwd,'SQLite',{root:storeRoot}).status).toBe('empty');
  store.put({text:'SQLite candidate'});
  const record=store.put({text:'SQLite stores project records',status:'verified',evidence:[{ref:'source:db.ts'}]});
  const result=recallKnowledge(cwd,'SQLite',{root:storeRoot});
  expect(result.status).toBe('ok');expect(result.candidatesExcluded).toBe(1);
  expect(result.memories).toHaveLength(1);expect(result.memories[0]).toMatchObject({revision:record.revision,evidenceRefs:[{ref:'source:db.ts'}],citation:{nodeId:'0001'}});
  expect(recallKnowledge(join(root,'foreign'),'SQLite',{root:storeRoot}).status).toBe('empty');
  expect(recallKnowledge(cwd,'astronomy',{root:storeRoot}).status).toBe('no-match');
  store.delete(record.id,record.revision);
  expect(recallKnowledge(cwd,'SQLite',{root:storeRoot}).memories).toEqual([]);
  writeFileSync(join(store.directory,'0000000000000099-invalid.json'),'invalid');
  expect(recallKnowledge(cwd,'SQLite',{root:storeRoot}).status).toBe('unavailable');
 } finally {rmSync(root,{recursive:true,force:true});}
});
