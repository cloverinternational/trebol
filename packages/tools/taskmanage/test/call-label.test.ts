import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager, type JournalEntry } from '../src/task-manage.js';
import { swarmValidateTaskManageParams } from '../src/swarm-validate.js';

/**
 * TaskManage is in `VALIDATES_OWN_ARGUMENTS`, so its model-facing schema marks the
 * call label (`description`) required: Pi's prepareToolCall only checks the permissive
 * registered schema, and the real check is `swarmValidateTaskManageParams` inside the
 * tool's execute. Both that validator and `TaskManager.execute` therefore have to accept
 * the label, or every call becomes impossible — the model must send a field the tool rejects.
 * These tests pin both layers, in both directions.
 */
// A new task carries 1..12 questions; the label is unrelated to that requirement.
const create = { key: 'new', op: 'create' as const, subject: 'Carry a call label', questions: [{ id: 'q1', text: 'Does the label stay out of task data?' }] };

function manager() {
  const root = mkdtempSync(join(tmpdir(), 'task-label-'));
  const entries: JournalEntry[] = [];
  return new TaskManager(e => entries.push(e), undefined, { workspaceRoot: root });
}

describe('TaskManage call label', () => {
  it('accepts the label at both validation layers and never stores it as task data', () => {
    const tasks = manager();
    const label = 'Add /upgradegoal command';
    // The tool's pre-execution validator (the layer that threw for every call).
    expect(swarmValidateTaskManageParams({ description: label, operations: [create] })).toBeUndefined();
    // The manager's own top-level check.
    expect(tasks.execute({ description: label, operations: [create] }).status).toBe('succeeded');
    const read = tasks.execute({ operations: [{ key: 'g', op: 'get', taskId: '1' }] });
    expect(read.status).toBe('succeeded');
    expect(JSON.stringify(read)).not.toContain(label);
    expect(JSON.stringify(read)).toContain('Carry a call label');
  });

  it('still rejects a genuinely unknown top-level field by name', () => {
    const tasks = manager();
    expect(swarmValidateTaskManageParams({ label: 'Label', operations: [create] })).toBe('unknown top-level field "label"');
    const batch = tasks.execute({ bogus: 1, operations: [create] } as never);
    expect(batch.status).toBe('failed');
    expect(batch.results[0].error?.message).toBe('unknown top-level field "bogus"');
  });

  it('rejects a non-string label at both layers', () => {
    const tasks = manager();
    expect(swarmValidateTaskManageParams({ description: 42, operations: [create] } as never)).toBe('description must be a string');
    const batch = tasks.execute({ description: 42, operations: [create] } as never);
    expect(batch.status).toBe('failed');
    expect(batch.results[0].error?.message).toBe('description must be a string');
  });

  it('keeps mode and the operations requirement unchanged', () => {
    expect(swarmValidateTaskManageParams({ description: 'Label', mode: 'atomic', operations: [create] })).toBeUndefined();
    expect(swarmValidateTaskManageParams({ description: 'Label', operations: [] })).toBe('operations must contain at least one operation');
  });
});
