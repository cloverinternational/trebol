import {describe,test,expect} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearSupervisorOverride, loadSupervisorSettings, saveSupervisorSettings } from "../../lib/context/supervisor-settings.ts";

describe("supervisor settings", () => {
  test("uses defaults and preserves false project overrides", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-"));
    const result = saveSupervisorSettings(root, "project", { enabled: false, cadence: 2 }, { home: path.join(root, "home") });
    expect(result.settings.enabled).toBe(false);
    expect(result.settings.cadence).toBe(2);
    expect(result.origins.enabled).toBe("project");
  });

  test("global settings precede defaults and clear removes project override", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-"));
    const home = path.join(root, "home");
    saveSupervisorSettings(root, "global", { audit: false }, { home });
    saveSupervisorSettings(root, "project", { audit: true }, { home });
    expect(clearSupervisorOverride(root, { home }).settings.audit).toBe(false);
    expect(loadSupervisorSettings(root, { home }).settings.audit).toBe(false);
  });
});
test("rejects secrets unknown fields corrupt stores and symlink writes",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"supervisor-safe-")),options={home:path.join(root,"home")};
 try{
  expect(()=>saveSupervisorSettings(root,"project",{apiKey:"SECRET"} as any,options)).toThrow();
  expect(()=>saveSupervisorSettings(root,"project",{workerTurns:7},options)).toThrow();
  const p=loadSupervisorSettings(root,options).paths.project;fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'{"secret":"SENTINEL"');
  expect(loadSupervisorSettings(root,options).diagnostics.join("")).not.toContain("SENTINEL");expect(()=>saveSupervisorSettings(root,"project",{enabled:true},options)).toThrow();
  fs.unlinkSync(p);fs.writeFileSync(path.join(root,"outside"),'{}');fs.symlinkSync(path.join(root,"outside"),p);expect(()=>saveSupervisorSettings(root,"project",{enabled:true},options)).toThrow();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
