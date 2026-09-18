import {it,expect} from "vitest";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";import {tmpdir} from "node:os";
import {executionLog} from "../../lib/context/execution-log.ts";
it("writes local reviewable metadata and bounds size",()=>{const cwd=mkdtempSync(join(tmpdir(),"exec-log-"));try{
 const path=executionLog(cwd,"execution","bootstrap-result",{memoryIds:["m1"],tasksCommitted:1});
 expect(path).toContain(".swarmpi/execution/");expect(JSON.parse(readFileSync(path!,"utf8")).memoryIds).toEqual(["m1"]);
 expect(executionLog(cwd,"jev","oversized",{value:"x".repeat(40000)})).toBeUndefined();
}finally{rmSync(cwd,{recursive:true,force:true});}});
