import {afterEach,it,expect} from "vitest";
import {existsSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join,sep} from "node:path";import {tmpdir} from "node:os";
import {executionLog} from "../../lib/context/execution-log.ts";

const saved={enabled:process.env.PI_SWARM_DIAGNOSTICS,dir:process.env.PI_SWARM_DIAGNOSTICS_DIR};
afterEach(()=>{for(const [name,value] of [["PI_SWARM_DIAGNOSTICS",saved.enabled],["PI_SWARM_DIAGNOSTICS_DIR",saved.dir]] as const){
 if(value===undefined) delete process.env[name]; else process.env[name]=value;}});

it("writes nothing by default and never inside the working tree",()=>{delete process.env.PI_SWARM_DIAGNOSTICS;
 const cwd=mkdtempSync(join(tmpdir(),"exec-log-"));try{
  expect(executionLog(cwd,"execution","bootstrap-result",{memoryIds:["m1"]})).toBeUndefined();
  expect(existsSync(join(cwd,".swarmpi"))).toBe(false);
 }finally{rmSync(cwd,{recursive:true,force:true});}});

it("writes bounded metadata outside the worktree when diagnostics are enabled",()=>{const cwd=mkdtempSync(join(tmpdir(),"exec-log-"));
 const state=mkdtempSync(join(tmpdir(),"exec-state-"));try{
  process.env.PI_SWARM_DIAGNOSTICS="1";process.env.PI_SWARM_DIAGNOSTICS_DIR=state;
  const path=executionLog(cwd,"execution","bootstrap-result",{memoryIds:["m1"],tasksCommitted:1});
  expect(path!.startsWith(state+sep)).toBe(true);expect(path!.startsWith(cwd+sep)).toBe(false);
  expect(existsSync(join(cwd,".swarmpi"))).toBe(false);
  expect(JSON.parse(readFileSync(path!,"utf8")).memoryIds).toEqual(["m1"]);
  expect(executionLog(cwd,"jev","oversized",{value:"x".repeat(40000)})).toBeUndefined();
 }finally{rmSync(cwd,{recursive:true,force:true});rmSync(state,{recursive:true,force:true});}});
