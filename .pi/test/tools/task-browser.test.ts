import {it,expect} from 'vitest';
import {TaskBrowserView} from '../../extensions/30-tools/task-browser.ts';
import {taskWidgetRenderer} from '../../../packages/tools/taskmanage/src/task-manage.ts';
it('does not grow with a hundred unfocused tasks',()=>{const tasks=Array.from({length:100},(_,i)=>({id:String(i),subject:'Work',status:'pending',dependsOn:[]}));expect(taskWidgetRenderer(tasks as any,{}).render(80)).toHaveLength(3);});
it('closes immediately on Escape from every view',()=>{
 let closed=0;
 const view=new TaskBrowserView({requestRender(){},terminal:{rows:20}}, {},()=>({tasks:[{id:'1',subject:'One',status:'pending',dependsOn:[]}] as any}),()=>{closed++;},{wrapTextWithAnsi:(s,w)=>[s],truncateToWidth:(s,w)=>s.slice(0,w)});
 view.handleInput('\r');
 view.handleInput('\x1b');
 expect(closed).toBe(1);
 view.handleInput('\x1b');
 expect(closed).toBe(1);
});
it('keeps selected ID after insertions and scrolls to final evidence without mutations',()=>{
 let tasks:any[]=[{id:'1',subject:'One',status:'pending'},{id:'2',subject:'Two',status:'pending',questions:Array.from({length:12},(_,i)=>({id:`q${i}`,text:'Question '.repeat(30)})),answers:[{question:'q11',answer:'answer',evidence:'LAST-EVIDENCE'}]}];
 const view=new TaskBrowserView({requestRender(){},terminal:{rows:20}}, {},()=>({tasks}),()=>{},{wrapTextWithAnsi:(s,w)=>s.match(new RegExp(`.{1,${w}}`,"g"))??[""],truncateToWidth:(s,w)=>s.slice(0,w)});
 view.render(60);view.handleInput('\x1b[B');tasks=[{id:'0',subject:'Inserted',status:'pending'},...tasks];view.handleInput('\r');
 expect(view.render(60).join('\n')).toContain('#2 Two');const before=JSON.stringify(tasks);let found=false;
 for(let i=0;i<150;i++){if(view.render(60).join('\n').includes('LAST-EVIDENCE'))found=true;view.handleInput('\x1b[B');}
 expect(found).toBe(true);expect(JSON.stringify(tasks)).toBe(before);
});

it('shows every focused question with status and dims only eligible next task',()=>{
 const tasks:any[]=[{id:'p',subject:'Parent',status:'pending',dependsOn:[]},{id:'c',parentTaskId:'p',subject:'Current',status:'in_progress',active:true,dependsOn:[],questions:[{id:'q1',text:'First question?'},{id:'q2',text:'Second question?'}],answers:[{question:'q1',answer:'Yes',evidence:'proof.md#Test'}]},{id:'b',subject:'Blocked',status:'pending',dependsOn:['missing']},{id:'n',subject:'Next work',status:'pending',dependsOn:[]}];
 const rows=taskWidgetRenderer(tasks,{dim:s=>`DIM(${s})`}).render(100);
 expect(rows.join('\n')).toContain('✓ q1: First question?');expect(rows.join('\n')).toContain('? q2: Second question?');
 expect(rows.at(-1)).toBe('DIM(  ↳ Next #n Next work)');expect(rows.join('\n')).not.toContain('Blocked');expect(rows).toHaveLength(5);
});
