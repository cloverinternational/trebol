import {it,expect} from 'vitest';
import {bootstrapBrief} from '../../lib/context/bootstrap-brief.ts';
it('links selected evidence and loaded skills to committed planner instructions',()=>{
 const b=bootstrapBrief('goal',[{id:'knowledge:worktree:record:rev:node',text:'fact'}],[{name:'testing'}],[{id:'T1',guidance:'Test the constraint',questions:[{id:'q',text:'Passed?'}]}],{tasks:[{proposalKey:'T1',taskId:'7',status:'created'}]});
 expect(b.memoryIndex[0].read).toEqual({tool:'memory_history',operation:'get',scope:'worktree',id:'record'});
 expect(b.tasks[0].instructions).toBe('Test the constraint');expect(b.tasks[0].taskId).toBe('7');
 expect(b.tasks[0].context).toEqual({memories:['M1'],skills:['S1']});
 expect(b.skillIndex[0].instructionsAt).toBe('loadedSkills[0].content');
});
it('does not invent durable IDs for legacy memory and handles reused tasks',()=>{
 const b=bootstrapBrief('goal',[{id:'legacy',text:'claim'}],[],[],{tasks:[{taskId:'1'}]},[{id:'1',description:'Continue existing work'}]);
 expect(b.memoryIndex[0].read).toBeUndefined();expect(b.memoryIndex[0].status).toBe('unverified');
 expect(b.tasks[0].instructions).toBe('Continue existing work');
});
