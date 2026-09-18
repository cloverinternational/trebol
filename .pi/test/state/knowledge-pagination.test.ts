import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openKnowledgeStore } from '../../lib/state/knowledge-store.ts';
import { recallKnowledge } from '../../lib/context/knowledge-recall.ts';

it('enumerates beyond the legacy list bound while preserving current records', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-page-'));
  try {
    const cwd = join(root, 'project'), storeRoot = join(root, 'store');
    const store = openKnowledgeStore({ cwd, root: storeRoot });
    for (let i = 0; i < 101; i++) store.put({ id: `record-${i}`, text: `pagination item ${i}`, status: 'verified', evidence: [{ ref: `test:${i}` }] });
    const deleted = store.put({ id: 'deleted', text: 'pagination deleted', status: 'verified', evidence: [{ ref: 'test:deleted' }] });
    store.delete(deleted.id, deleted.revision);
    store.put({ id: 'candidate', text: 'pagination candidate' });
    const result = recallKnowledge(cwd, 'pagination item 100', { root: storeRoot, scopes: ['repository'] });
    expect(result.status).toBe('ok');
    expect(result.memories[0].text).toContain('100');
    expect(result.candidatesExcluded).toBe(1);
    expect(result.scannedRecords).toBe(103);
    expect(store.list(100)).toHaveLength(100);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
