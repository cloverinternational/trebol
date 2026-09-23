import {it,expect} from "vitest";import {readFileSync} from "node:fs";
it("all human input paths have no auto-dismiss timer",()=>{
 const source=readFileSync(".pi/extensions/30-tools/ask-user/index.ts","utf8");
 expect(source).not.toContain("setTimeout(() => done(null)");expect(source).not.toContain("timeout ? { timeout }");expect(source).toContain("Questions wait indefinitely");
 expect(source).toContain('signal.addEventListener("abort"');
});
