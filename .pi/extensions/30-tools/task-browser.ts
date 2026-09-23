type Layout = { visibleWidth?:(text:string)=>number; wrapTextWithAnsi:(text:string,width:number)=>string[]; truncateToWidth:(text:string,width:number)=>string };
type EscapeMatcher = (data:string) => boolean;
const fallbackEscape = (data:string) => data === "\x1b" || /^\x1b\[27;\d+(?:;\d+)?~$/.test(data);
export interface BrowserTask { id:string; subject:string; description?:string; status?:string; active?:boolean; dependsOn?:string[]; parentTaskId?:string; questions?:Array<{id:string;text:string}>; answers?:Array<{question:string;answer:string;evidence:string}>; notes?:string[] }
export interface BrowserSnapshot {tasks:BrowserTask[]}
export class TaskBrowserView {
 private id:string|undefined; private detail=false; private scroll=0; private filter="open"; private query=""; private search=false; private collapsed=new Set<string>();
 private closed=false;
 constructor(private tui:any,private theme:any,private read:()=>BrowserSnapshot,private close:()=>void, private layout:Layout, private isEscape:EscapeMatcher = fallbackEscape){}
 private rows(){
  const all=this.read().tasks.filter(t=>t.status!=="deleted"); const byId=new Map(all.map(t=>[t.id,t]));
  const blocked=(t:BrowserTask)=>(t.dependsOn??[]).some(id=>byId.get(id)?.status!=="completed");
  const matches=all.filter(t=>(this.filter==="all"||this.filter==="open"&&t.status!=="completed"||this.filter==="blocked"&&blocked(t)||this.filter===t.status)&&`${t.id} ${t.subject} ${t.description??""}`.toLowerCase().includes(this.query.toLowerCase()));
  const visible=new Set(matches.map(t=>t.id));const rows:Array<{task:BrowserTask;depth:number}>=[];const seen=new Set<string>();
  const visit=(t:BrowserTask,depth:number)=>{if(seen.has(t.id))return;seen.add(t.id);rows.push({task:t,depth});if(!this.collapsed.has(t.id)||this.query)for(const c of matches.filter(c=>c.parentTaskId===t.id))visit(c,depth+1);};
  for(const t of matches)if(!t.parentTaskId||!visible.has(t.parentTaskId))visit(t,0);
  if(!rows.some(r=>r.task.id===this.id)){this.id=rows[0]?.task.id;this.scroll=0;}
  return rows;
 }
 handleInput(data:string){
  // Use the TUI key matcher rather than comparing against one terminal's raw
  // byte sequence. Kitty/modifyOtherKeys terminals can encode Escape
  // differently, which previously left this overlay capturing input forever.
  if(this.isEscape(data)){if(!this.closed){this.closed=true;this.close();}return;}
  if(this.search){if(data==="\r")this.search=false;else if(data==="\x7f")this.query=Array.from(this.query).slice(0,-1).join("");else if(!/[\x00-\x1f]/.test(data))this.query+=data;this.scroll=0;this.invalidate();return;}
  const rows=this.rows();const i=rows.findIndex(r=>r.task.id===this.id);
  const delta=data==="\x1b[A"||data==="k"?-1:data==="\x1b[B"||data==="j"?1:data==="\x1b[6~"?10:data==="\x1b[5~"?-10:0;
  if(delta){if(this.detail)this.scroll=Math.max(0,this.scroll+delta);else this.id=rows[Math.max(0,Math.min(rows.length-1,i+delta))]?.task.id;}
  else if(data==="\r"){this.detail=true;this.scroll=0;}
  else if(data==="/"&&!this.detail){this.search=true;this.query="";}
  else if(data==="f"&&!this.detail){const fs=["open","blocked","completed","all"];this.filter=fs[(fs.indexOf(this.filter)+1)%fs.length];}
  else if(data===" "&&!this.detail&&this.id){if(this.collapsed.has(this.id))this.collapsed.delete(this.id);else this.collapsed.add(this.id);}
  this.invalidate();
 }
 render(width:number){
  const outerWidth=Math.max(1,width);width=Math.max(1,outerWidth-4);const height=Math.max(4,Math.floor((this.tui.terminal?.rows??24)*.8)-2);const rows=this.rows();const index=rows.findIndex(r=>r.task.id===this.id);const task=rows[index]?.task;let body:string[]=[];
  if(this.detail&&task){const text=[`#${task.id} ${task.subject}`,`Status: ${task.status} · Parent: ${task.parentTaskId??"none"}`,task.description??"No description",`Dependencies: ${(task.dependsOn??[]).join(", ")||"none"}`];
   if(!task.questions?.length)text.push("Acceptance questions missing — repair required");
   for(const q of task.questions??[]){const a=task.answers?.find(a=>a.question===q.id);text.push(`Q ${q.id}: ${q.text}`,a?`Answer: ${a.answer}`:"Answer: unanswered",...(a?[`Evidence: ${a.evidence}`]:[]));}
   text.push(...(task.notes??[]).map(n=>`Note: ${n}`));body=text.flatMap(t=>this.layout.wrapTextWithAnsi(t,width));
  }else body=rows.map(({task:t,depth})=>`${t.id===this.id?"▶":" "} ${"  ".repeat(Math.min(depth,5))}#${t.id} [${t.status}] ${t.subject}`);
  const count=Math.max(1,height-5);if(!this.detail)this.scroll=Math.max(0,index-count+1);this.scroll=Math.min(this.scroll,Math.max(0,body.length-count));
  const content = [`TASKS  ·  ${this.detail?"DETAILS":this.filter.toUpperCase()}  ·  read only`,this.search?`Search: ${this.query}_`:`${rows.length} task${rows.length===1?"":"s"} · lines ${body.length?this.scroll+1:0}–${Math.min(body.length,this.scroll+count)}/${body.length}`,...(body.length?body.slice(this.scroll,this.scroll+count):["No matching tasks"]),"↑↓ navigate · Enter details · Space tree · / search · f filter · Esc close"].map(l=>{ const text=this.layout.truncateToWidth(l,width); return text + " ".repeat(Math.max(0,width-(this.layout.visibleWidth?.(text) ?? Array.from(text).length))); });
  const accent=(text:string)=>this.theme.fg?.("accent",text)??text;
  const border=accent("┌"+"─".repeat(Math.max(0,outerWidth-2))+"┐");
  const bottom=accent("└"+"─".repeat(Math.max(0,outerWidth-2))+"┘");
  return [border,...content.map((line,i)=>accent("│ ")+(i===0?(this.theme.bold?.(line)??line):line)+accent(" │")),bottom];
 }
 invalidate(){this.tui.requestRender();}
}
const openManagers=new WeakSet<object>();
export async function openTaskBrowser(ctx:any,manager:{snapshot():BrowserSnapshot}){
 if(openManagers.has(manager))return;openManagers.add(manager);
 try{const layout = await import("@earendil-works/pi-tui"); await ctx.ui.custom((tui:any,theme:any,_keys:any,done:()=>void)=>new TaskBrowserView(tui,theme,()=>manager.snapshot(),done,layout, (data:string)=>layout.matchesKey(data, layout.Key.escape)),{overlay:true,overlayOptions:{width:"88%",minWidth:48,maxHeight:"82%",anchor:"center",margin:1}});}finally{openManagers.delete(manager);}
}
