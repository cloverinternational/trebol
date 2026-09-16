import { expect, it, vi } from "vitest";
import { consultWithPi } from "../../lib/context/context-consult.ts";

const input = { prompt: "choose sections", cwd: "/tmp", model: { provider: "test", id: "model" } };
it("uses supported exec arguments and text output, not JSONL as a JSON object", async () => {
  const exec = vi.fn(async (..._args: any[]) => ({ code: 0, stdout: '{"found":false,"nodes":[]}' }));
  expect((await consultWithPi({exec}, input)).status).toBe("completed");
  const [command,args,options] = exec.mock.calls[0];
  expect(command).toBe("pi");
  for (const flag of ["--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-tools", "--no-prompt-templates"]) expect(args).toContain(flag);
  expect(args[args.indexOf("--mode")+1]).toBe("text");
  expect(options).not.toHaveProperty("maxBuffer");
  expect(options.timeout).toBeGreaterThan(0);
});
it("distinguishes process failure, malformed response and cancellation", async () => {
  expect(await consultWithPi({exec:async()=>({code:1,stderr:"sensitive diagnostics"})},input)).toEqual({status:"model-failure",error:"consultation process failed (1)"});
  expect((await consultWithPi({exec:async()=>({code:0,stdout:"not JSON"})},input)).status).toBe("malformed-json");
  const controller=new AbortController();controller.abort();const exec=vi.fn();
  expect((await consultWithPi({exec},{...input,signal:controller.signal})).status).toBe("cancelled");expect(exec).not.toHaveBeenCalled();
  expect((await consultWithPi({exec},{...input,generation:1,currentGeneration:()=>2})).status).toBe("cancelled");
});
