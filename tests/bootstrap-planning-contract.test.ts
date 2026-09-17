import { expect, it } from 'vitest';
import { validatePlan, buildPlanningPrompt, candidateGuidance } from '../tools/experiments/bootstrap-agent/planning-contract.mjs';
const action = { id: 'inspect', action: 'Inspect source', basis: 'Missing evidence', verification: 'Record findings', dependsOn: [] };
it('validates plans and rejects duplicate, cyclic, missing and forward dependencies', () => {
  const plan = { actions: [action], memoryAssessment: 'Unavailable', unknowns: [] };
  expect(validatePlan(plan)).toBe(plan);
  for (const actions of [[action, action], [{ ...action, dependsOn: ['inspect'] }], [{ ...action, dependsOn: ['missing'] }], [{ ...action, verification: '' }]]) expect(() => validatePlan({ ...plan, actions })).toThrow();
});
it('keeps experimental guidance general and distinguishes inspection and proof', () => {
  expect(candidateGuidance).toContain('read-only dependency can still be inspected');
  expect(candidateGuidance).toContain('Simulations are not proof');
  expect(candidateGuidance).not.toContain('tailscaled');
  expect(buildPlanningPrompt({ task: 'Review', evidence: {}, source: [] }, candidateGuidance)).toContain('Missing memory is not evidence');
});
