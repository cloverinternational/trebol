import { buildBoard, clampSelection, initialSelection, moveColumn, moveRow, selectedTask, type BoardSelection } from "../../.pi/lib/tern/task-board.ts";
import { renderBoard } from "./board.ts";
type Layout = { visibleWidth?:(text:string)=>number; wrapTextWithAnsi:(text:string,width:number)=>string[]; truncateToWidth:(text:string,width:number)=>string; parseKey:(data:string)=>string|undefined; decodeKittyPrintable:(data:string)=>string|undefined; isKeyRelease:(data:string)=>boolean };
type EscapeMatcher = (data:string) => boolean;
const fallbackEscape = (data:string) => data === "\x1b" || /^\x1b\[27;\d+(?:;\d+)?~$/.test(data);
export interface BrowserTask { id:string; subject:string; description?:string; status?:string; active?:boolean; dependsOn?:string[]; parentTaskId?:string; questions?:Array<{id:string;text:string}>; answers?:Array<{question:string;answer:string;evidence:string}>; notes?:string[] }
export interface BrowserSnapshot {tasks:BrowserTask[]}
export class TaskBrowserView {
 private id:string|undefined; private detail=false; private scroll=0; private filter="open"; private query=""; private search=false; private collapsed=new Set<string>();
 private view:"list"|"board"="list"; private sel:BoardSelection=initialSelection();
 private closed=false;
 constructor(private tui:any,private theme:any,private read:()=>BrowserSnapshot,private close:()=>void, private layout:Layout, private isEscape:EscapeMatcher = fallbackEscape){}
 private matched(){
  const all=this.read().tasks.filter(t=>t.status!=="deleted"); const byId=new Map(all.map(t=>[t.id,t]));
  const blocked=(t:BrowserTask)=>(t.dependsOn??[]).some(id=>byId.get(id)?.status!=="completed");
  return all.filter(t=>(this.filter==="all"||this.filter==="open"&&t.status!=="completed"||this.filter==="blocked"&&blocked(t)||this.filter===t.status)&&`${t.id} ${t.subject} ${t.description??""}`.toLowerCase().includes(this.query.toLowerCase()));
 }
 private boardModel(){ return buildBoard(this.matched().map(t=>({...t,status:t.status??""}))); }
 private syncBoard(){ const m=this.boardModel(); this.sel=clampSelection(m,this.sel); this.id=selectedTask(m,this.sel)?.id ?? this.id; }
 private enterBoard(){
  this.view="board"; const m=this.boardModel(); const col=m.columns.findIndex(c=>c.tasks.some(t=>t.id===this.id));
  this.sel=col>=0?{view:"board",column:col,row:m.columns[col]!.tasks.findIndex(t=>t.id===this.id)}:initialSelection();
  this.syncBoard();
 }
 private rows(){
  const matches=this.matched(); const visible=new Set(matches.map(t=>t.id));const rows:Array<{task:BrowserTask;depth:number}>=[];const seen=new Set<string>();
  const visit=(t:BrowserTask,depth:number)=>{if(seen.has(t.id))return;seen.add(t.id);rows.push({task:t,depth});if(!this.collapsed.has(t.id)||this.query)for(const c of matches.filter(c=>c.parentTaskId===t.id))visit(c,depth+1);};
  for(const t of matches)if(!t.parentTaskId||!visible.has(t.parentTaskId))visit(t,0);
  if(!rows.some(r=>r.task.id===this.id)){this.id=rows[0]?.task.id;this.scroll=0;}
  return rows;
 }
 handleInput(data:string){
  // Use the TUI key matcher rather than comparing against one terminal's raw
  // byte sequence. Kitty/modifyOtherKeys terminals can encode Escape
  // differently, which previously left this overlay capturing input forever.
  if(this.layout.isKeyRelease(data))return;
  // Decode one complete sequence, never its constituent bytes. CSI-u printable
  // input and legacy keys share the same navigation and filter handling.
  const key=this.layout.parseKey(data);
  const printable=this.layout.decodeKittyPrintable(data)??(data.length===1&&!/[\x00-\x1f\x7f]/.test(data)?data:undefined);
  if(this.isEscape(data)){if(!this.closed){this.closed=true;this.close();}return;}
  if(this.search){if(key==="enter")this.search=false;else if(key==="backspace")this.query=Array.from(this.query).slice(0,-1).join("");else if(printable)this.query+=printable;this.scroll=0;this.invalidate();return;}
  if(!this.detail&&key==="v"){if(this.view==="board")this.view="list";else this.enterBoard();this.invalidate();return;}
  if(this.view==="board"&&!this.detail){
   const m=this.boardModel();
   const next=key==="left"?moveColumn(m,this.sel,-1):key==="right"?moveColumn(m,this.sel,1):key==="up"?moveRow(m,this.sel,-1):key==="down"?moveRow(m,this.sel,1):undefined;
   if(next){this.sel=next;this.syncBoard();this.invalidate();return;}
  }
  const rows=this.rows();const i=rows.findIndex(r=>r.task.id===this.id);
  const delta=key==="up"||key==="k"?-1:key==="down"||key==="j"?1:key==="pageDown"?10:key==="pageUp"?-10:0;
  if(delta){if(this.detail)this.scroll=Math.max(0,this.scroll+delta);else this.id=rows[Math.max(0,Math.min(rows.length-1,i+delta))]?.task.id;}
  else if(key==="enter"){this.detail=true;this.scroll=0;}
  else if(key==="/"&&!this.detail){this.search=true;this.query="";}
  else if(key==="f"&&!this.detail){const fs=["open","blocked","completed","all"];this.filter=fs[(fs.indexOf(this.filter)+1)%fs.length];}
  else if(key==="space"&&!this.detail&&this.id){if(this.collapsed.has(this.id))this.collapsed.delete(this.id);else this.collapsed.add(this.id);}
  this.invalidate();
 }
 render(width:number){
  const outerWidth=Math.max(1,width);width=Math.max(1,outerWidth-4);const height=Math.max(4,Math.floor((this.tui.terminal?.rows??24)*.8)-2);const rows=this.rows();const index=rows.findIndex(r=>r.task.id===this.id);const task=rows[index]?.task;let body:string[]=[];
  const boardMode=this.view==="board"&&!this.detail;
  if(boardMode){const m=this.boardModel();body=renderBoard(m as any,this.sel,width,this.layout,this.theme);this.scroll=0;}
  else if(this.detail&&task){const text=[`#${task.id} ${task.subject}`,`Status: ${task.status} · Parent: ${task.parentTaskId??"none"}`,task.description??"No description",`Dependencies: ${(task.dependsOn??[]).join(", ")||"none"}`];
   if(!task.questions?.length)text.push("Acceptance questions missing — repair required");
   for(const q of task.questions??[]){const a=task.answers?.find(a=>a.question===q.id);text.push(`Q ${q.id}: ${q.text}`,a?`Answer: ${a.answer}`:"Answer: unanswered",...(a?[`Evidence: ${a.evidence}`]:[]));}
   text.push(...(task.notes??[]).map(n=>`Note: ${n}`));body=text.flatMap(t=>this.layout.wrapTextWithAnsi(t,width));
  }else body=rows.map(({task:t,depth})=>`${t.id===this.id?"▶":" "} ${"  ".repeat(Math.min(depth,5))}#${t.id} [${t.status}] ${t.subject}`);
  const count=Math.max(1,height-5);if(!this.detail&&!boardMode)this.scroll=Math.max(0,index-count+1);this.scroll=Math.min(this.scroll,Math.max(0,body.length-count));
  const keys=boardMode?"←→ column · ↑↓ card · Enter details · v list · Esc close":"↑↓ navigate · Enter details · Space tree · / search · f filter · v board · Esc close";
  const content = [`TASKS  ·  ${this.detail?"DETAILS":boardMode?"BOARD":this.filter.toUpperCase()}  ·  read only`,this.search?`Search: ${this.query}_`:`${rows.length} task${rows.length===1?"":"s"} · lines ${body.length?this.scroll+1:0}–${Math.min(body.length,this.scroll+count)}/${body.length}`,...(body.length?body.slice(this.scroll,this.scroll+count):["No matching tasks"]),keys].map(l=>{ const text=this.layout.truncateToWidth(l,width); return text + " ".repeat(Math.max(0,width-(this.layout.visibleWidth?.(text) ?? Array.from(text).length))); });
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
