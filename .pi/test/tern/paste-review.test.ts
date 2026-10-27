import { expect, it, vi } from "vitest";
import { DraftEditor } from "../../lib/tern/draft-edit.ts";
import { PasteInput } from "../../lib/tern/paste-input.ts";

it("rejects over-limit payload visibly, consumes no controls and releases buffers", () => {
 const keys:string[]=[], pastes:string[]=[], notices:string[]=[];
 const p=new PasteInput(s=>keys.push(s),s=>pastes.push(s),{maxBytes:8,onRecovery:s=>notices.push(s)});
 p.process('\x1b[200~123456789\x1b[201~\r');
 expect(pastes).toEqual([]); expect(keys).toEqual([]); expect(notices[0]).toContain('entire paste rejected');
 expect(p.bufferedBytes).toBe(0); expect(p.recovering).toBe(true); p.dispose();
});
it("EOF preserves partial data once; cancel and disposal release data without executing it", () => {
 for(const action of ['end','cancel','dispose'] as const){
  const keys:string[]=[], pastes:string[]=[];
  const p=new PasteInput(s=>keys.push(s),s=>pastes.push(s));
  p.process('\x1b[200~a\r\x03\x1b'); p[action]();
  expect(keys).toEqual([]); expect(pastes).toEqual(action==='end'?['a\r\x03\x1b']:[]);
  expect(p.bufferedBytes).toBe(0);p.dispose();
 }
});
it("completion cancels watchdog and repeated paste works after recovery", () => {
 vi.useFakeTimers();
 try {
  const notices:string[]=[], pastes:string[]=[];
  const p=new PasteInput(()=>{},s=>pastes.push(s),{timeoutMs:10,onRecovery:s=>notices.push(s)});
  p.process('\x1b[200~ok\x1b[201~');vi.advanceTimersByTime(20);expect(notices).toEqual([]);
  p.process('\x1b[200~partial');vi.advanceTimersByTime(20);p.resume();
  p.process('\x1b[200~next\x1b[201~');expect(pastes).toEqual(['ok','partial','next']);p.dispose();
  expect(vi.getTimerCount()).toBe(0);
 } finally {vi.useRealTimers();}
});
it("undo restores real token identity while literals and surrounding edits stay literal", () => {
 const e=new DraftEditor();e.insertPaste('a\nb');const marker=e.text;
 e.insert(marker);expect(e.expandedText).toBe('a\nb'+marker);
 e.undo();expect(e.expandedText).toBe('a\nb');
 e.setText('');e.undo();expect(e.expandedText).toBe('a\nb');
 e.setText(marker);expect(e.expandedText).toBe(marker);
 e.dispose();expect(e.retainedPasteCount).toBe(0);
});

it("literal marker never acquires payload identity", () => {
 const e = new DraftEditor(); e.insertPaste('a\nb'); const marker=e.text;
 e.setText(''); e.insert(marker); expect(e.expandedText).toBe(marker);
});
it("old payloads disappear after undo eviction and disposal", () => {
 const e = new DraftEditor();
 for(let i=0;i<300;i++){e.insertPaste(String(i)+'x'.repeat(1000));e.setText('');}
 expect(e.retainedPasteCount).toBeLessThanOrEqual(100);
 e.dispose(); expect(e.retainedPasteCount).toBe(0);
});
it("timeout requires explicit recovery and never dispatches captured controls", () => {
 vi.useFakeTimers();
 try {
  const keys:string[]=[], pastes:string[]=[], notices:string[]=[];
  const p=new PasteInput(s=>keys.push(s),s=>pastes.push(s),{timeoutMs:50,onRecovery:s=>notices.push(s)});
  p.process('\x1b[200~'+'x'.repeat(102400)+'\x03\x1b');
  p.process(''); // a partial UTF-8 codepoint must not disarm the watchdog
  vi.advanceTimersByTime(51);
  expect(notices.length).toBe(1); expect(keys).toEqual([]);
  expect(pastes).toEqual(['x'.repeat(102400)+'\x03\x1b']);
  p.process('\rUNTRUSTED'); expect(keys).toEqual([]);
  p.resume(); p.process('safe'); expect(keys).toEqual(['safe']); p.dispose();
 } finally {vi.useRealTimers();}
});
