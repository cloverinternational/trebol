import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager, type JournalEntry } from '../src/task-manage.js';

// Regression contracts for the TaskManage evidence/answer reports, written
// against approved behaviour. Expected RED on unmodified source where marked.

const q1 = { id: 'q1', text: 'First acceptance question?' };
const q2 = { id: 'q2', text: 'Second acceptance question?' };
const a1 = { question: 'q1', answer: 'Verified in proof.', evidence: 'proof.md#Proof' };
const a2 = { question: 'q2', answer: 'Verified in notes.', evidence: 'proof.md#Notes' };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'taskmanage-regress-ws-'));
  writeFileSync(join(root, 'proof.md'), '# Proof\nok\n\n# Notes\nmore\n');
  return root;
}

function fixture(questions = [q1, q2]) {
  const root = workspace();
  const entries: JournalEntry[] = [];
  const manager = new TaskManager(e => entries.push(e), undefined, { workspaceRoot: root });
  const created = manager.execute({ operations: [{ key: 'new', op: 'create', subject: 'Regress', questions }] });
  expect(created.status).toBe('succeeded');
  return { root, entries, manager, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('#176/#184 saved answer reuse and per-question invalidation', () => {
  it('completes with no resubmitted answers when saved answers already cover every question', () => {
    const { manager, cleanup } = fixture();
    try {
      expect(manager.execute({ operations: [{ key: 'save', op: 'update', taskId: '1', answers: [a1, a2] }] }).status).toBe('succeeded');
      const done = manager.execute({ operations: [{ key: 'done', op: 'update', taskId: '1', status: 'completed' }] });
      expect(done.status).toBe('succeeded');
      expect(manager.snapshot().tasks[0].status).toBe('completed');
    } finally { cleanup(); }
  });

  it('merges a partial override by question ID over saved answers', () => {
    const { manager, cleanup } = fixture();
    try {
      manager.execute({ operations: [{ key: 'save', op: 'update', taskId: '1', answers: [a1, a2] }] });
      const override = { question: 'q2', answer: 'Re-verified after edit.', evidence: 'proof.md#Notes' };
      expect(manager.execute({ operations: [{ key: 'done', op: 'update', taskId: '1', status: 'completed', answers: [override] }] }).status).toBe('succeeded');
      const answers = manager.snapshot().tasks[0].answers ?? [];
      expect(answers.find(a => a.question === 'q1')?.answer).toBe(a1.answer);
      expect(answers.find(a => a.question === 'q2')?.answer).toBe('Re-verified after edit.');
    } finally { cleanup(); }
  });

  it('invalidates only the answer of a changed question, retaining unchanged answers', () => {
    const { manager, cleanup } = fixture();
    try {
      manager.execute({ operations: [{ key: 'save', op: 'update', taskId: '1', answers: [a1, a2] }] });
      const changed = { id: 'q2', text: 'Reworded second question?' };
      expect(manager.execute({ operations: [{ key: 'edit', op: 'update', taskId: '1', questions: [q1, changed] }] }).status).toBe('succeeded');
      const answers = manager.snapshot().tasks[0].answers ?? [];
      expect(answers.map(a => a.question)).toEqual(['q1']);
    } finally { cleanup(); }
  });

  it('keeps answers for reordered questions whose text is unchanged', () => {
    const { manager, cleanup } = fixture();
    try {
      manager.execute({ operations: [{ key: 'save', op: 'update', taskId: '1', answers: [a1, a2] }] });
      expect(manager.execute({ operations: [{ key: 'reorder', op: 'update', taskId: '1', questions: [q2, q1] }] }).status).toBe('succeeded');
      expect((manager.snapshot().tasks[0].answers ?? []).map(a => a.question).sort()).toEqual(['q1', 'q2']);
    } finally { cleanup(); }
  });

  it('still blocks completion when a question has no saved or supplied answer', () => {
    const { manager, cleanup } = fixture();
    try {
      manager.execute({ operations: [{ key: 'save', op: 'update', taskId: '1', answers: [a1] }] });
      const result = manager.execute({ operations: [{ key: 'done', op: 'update', taskId: '1', status: 'completed' }] });
      expect(result.status).toBe('failed');
      expect(result.results[0].error?.message).toMatch(/q2/);
      expect(manager.snapshot().tasks[0].status).toBe('pending');
    } finally { cleanup(); }
  });
});

describe('#173/#176 evidence revalidation of reused answers', () => {
  it('control: explicit answers citing deleted evidence are rejected and name the reference', () => {
    const { root, manager, cleanup } = fixture([q1]);
    try {
      rmSync(join(root, 'proof.md'));
      const result = manager.execute({ operations: [{ key: 'done', op: 'update', taskId: '1', status: 'completed', answers: [{ ...a1, question: 'q1' }] }] });
      expect(result.status).toBe('failed');
      expect(result.results[0].error?.message).toMatch(/evidence reference is unavailable: proof\.md#Proof/);
    } finally { cleanup(); }
  });

  it('rejects completion when evidence for a reused answer was deleted, naming the reference', () => {
    const { root, manager, cleanup } = fixture();
    try {
      manager.execute({ operations: [{ key: 'save', op: 'update', taskId: '1', answers: [a1, a2] }] });
      rmSync(join(root, 'proof.md'));
      const result = manager.execute({ operations: [{ key: 'done', op: 'update', taskId: '1', status: 'completed' }] });
      expect(result.status).toBe('failed');
      expect(result.results[0].error?.message).toMatch(/evidence.*unavailable.*proof\.md#Proof/s);
      expect(manager.snapshot().tasks[0].status).toBe('pending');
    } finally { cleanup(); }
  });
});

describe('#187/#194 trusted extra evidence roots', () => {
  it('resolves a citation into an explicitly authorised extra root', () => {
    const root = workspace();
    const extra = mkdtempSync(join(tmpdir(), 'taskmanage-regress-extra-'));
    writeFileSync(join(extra, 'spec.md'), '# Spec\nagreed\n');
    const manager = new TaskManager(undefined, undefined, { workspaceRoot: root, evidenceRoots: [extra] } as any);
    try {
      manager.execute({ operations: [{ key: 'new', op: 'create', subject: 'Extra', questions: [q1] }] });
      const result = manager.execute({ operations: [{ key: 'done', op: 'update', taskId: '1', status: 'completed', answers: [{ question: 'q1', answer: 'Per spec.', evidence: `${join(extra, 'spec.md')}#Spec` }] }] });
      expect(result.status).toBe('succeeded');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(extra, { recursive: true, force: true }); }
  });

  it('does not authorise an unlisted sibling directory and does not leak its contents', () => {
    const root = workspace();
    const sibling = mkdtempSync(join(tmpdir(), 'taskmanage-regress-sibling-'));
    writeFileSync(join(sibling, 'secret.md'), '# Notes\nTOPSECRET-BODY-7f3a\n');
    const manager = new TaskManager(undefined, undefined, { workspaceRoot: root } as any);
    try {
      manager.execute({ operations: [{ key: 'new', op: 'create', subject: 'Sibling', questions: [q1] }] });
      const result = manager.execute({ operations: [{ key: 'done', op: 'update', taskId: '1', status: 'completed', answers: [{ question: 'q1', answer: 'Peeked.', evidence: `${join(sibling, 'secret.md')}#Notes` }] }] });
      expect(result.status).toBe('failed');
      expect(JSON.stringify(result)).not.toContain('TOPSECRET-BODY');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(sibling, { recursive: true, force: true }); }
  });

  it('rejects task input that tries to grant itself an evidence root', () => {
    const root = workspace();
    const manager = new TaskManager(undefined, undefined, { workspaceRoot: root } as any);
    try {
      const result = manager.execute({ operations: [{ key: 'new', op: 'create', subject: 'Grant', questions: [q1], evidenceRoots: ['/'] } as any] });
      expect(result.status).toBe('failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('#153 blocked-task note batches', () => {
  it('accepts a note-only update on a blocked pending task', () => {
    const { manager, cleanup } = fixture();
    try {
      manager.execute({ operations: [{ key: 'block', op: 'update', taskId: '1', addNote: 'waiting', noteType: 'blocker' }] });
      const result = manager.execute({ operations: [{ key: 'note', op: 'update', taskId: '1', addNote: 'more context', noteType: 'observation' }] });
      expect(result.status).toBe('succeeded');
      expect(manager.snapshot().tasks[0].notes).toContain('more context');
    } finally { cleanup(); }
  });

  it('rejects combined activation plus note on a blocked task with no state or note change', () => {
    const { manager, cleanup } = fixture();
    try {
      const before = JSON.stringify(manager.snapshot().tasks);
      const result = manager.execute({ operations: [{ key: 'both', op: 'update', taskId: '1', status: 'in_progress', active: true, addNote: 'start', noteType: 'milestone' }] });
      expect(result.status).toBe('failed');
      expect(JSON.stringify(manager.snapshot().tasks)).toBe(before);
    } finally { cleanup(); }
  });
});

describe('#133 persistence of saved answers across replay', () => {
  it('replays saved answers from the journal after reload', () => {
    const { root, entries, manager, cleanup } = fixture();
    try {
      manager.execute({ operations: [{ key: 'save', op: 'update', taskId: '1', answers: [a1, a2] }] });
      const reloaded = new TaskManager(undefined, undefined, { workspaceRoot: root });
      reloaded.rehydrate(entries);
      expect((reloaded.snapshot().tasks[0].answers ?? []).length).toBe(2);
    } finally { cleanup(); }
  });
});

describe('fixture setup', () => {
  it('creates a real workspace fixture containing the cited proof file', () => {
    const { root, cleanup } = fixture();
    try { expect(existsSync(join(root, 'proof.md'))).toBe(true); }
    finally { cleanup(); }
  });
});
