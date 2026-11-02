import { describe, expect, it } from "vitest";
import { registerTaskManage, TaskManager, taskManageSchema, type Params } from "../../../packages/tools/taskmanage/src/task-manage.ts";
import { swarmValidateTaskManageParams } from "../../../packages/tools/taskmanage/src/swarm-validate.ts";
import { applySwarmSurface, loadSwarmCanonicalTools, PERMISSIVE_PARAMETERS, VALIDATES_OWN_ARGUMENTS } from "../../lib/runtime/swarm-tool-surface.ts";
import { stepHead } from "../../lib/tern/work-summary.ts";

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute(id: string, args: unknown): Promise<{ isError: boolean }>;
}

const create = () => ({
  description: "Add the upgradegoal command",
  operations: [{ key: "new", op: "create" as const, subject: "Implement upgradegoal", description: "Task details, not the call label", questions: [{ id: "verified", text: "Does the command pass its tests?" }] }],
});

function fixture() {
  let tool: RegisteredTool | undefined;
  const manager = registerTaskManage({ registerTool: registered => {
    // registerTaskManage exposes an opaque registration; this is its test-facing seam.
    const definition = registered as RegisteredTool;
    tool = applySwarmSurface(definition);
  }, appendEntry: () => {}, on: () => {} });
  if (!tool) throw new Error("TaskManage was not registered");
  return { tool, manager };
}

describe("TaskManage call description regression (#384)", () => {
  it("accepts a labelled create through both validators and preserves the Tern label", async () => {
    const { tool, manager } = fixture();
    const args = create();
    expect(VALIDATES_OWN_ARGUMENTS.has("TaskManage")).toBe(true);
    expect(tool.parameters).toEqual(PERMISSIVE_PARAMETERS);
    const schema = loadSwarmCanonicalTools().get("TaskManage")!.parameters;
    expect(schema).toHaveProperty("required", expect.arrayContaining(["description"]));
    expect(taskManageSchema.properties.description.type).toBe("string");
    expect(swarmValidateTaskManageParams(args)).toBeUndefined();
    const result = await tool.execute("create", args);
    expect(result.isError).toBe(false);
    expect(manager.snapshot().tasks).toHaveLength(1);
    expect(manager.snapshot().tasks[0].description).toBe(args.operations[0].description);
    expect(args.description).toBe("Add the upgradegoal command");
    expect(stepHead("TaskManage", args).intent).toBe(args.description);
    // Rendering labels must not participate in create idempotency.
    await expect(tool.execute("retry", { ...args, description: "Retry creating the command task" })).resolves.toMatchObject({ isError: false });
    expect(manager.snapshot().tasks).toHaveLength(1);
  });

  it("accepts labelled list calls and legacy calls without a label", async () => {
    const { tool } = fixture();
    for (const args of [{ description: "List the current tasks", operations: [{ key: "list", op: "list" }] }, { operations: [{ key: "list", op: "list" }] }]) {
      await expect(tool.execute("list", args)).resolves.toMatchObject({ isError: false });
    }
    const args: Params = create();
    delete args.description;
    expect(new TaskManager().execute(args).status).toBe("succeeded");
  });

  it("still rejects genuinely unknown top-level fields by name without mutation", async () => {
    const { tool, manager } = fixture();
    const args = { ...create(), bogusField: true };
    expect(swarmValidateTaskManageParams(args)).toBe('unknown top-level field "bogusField"');
    await expect(tool.execute("invalid", args)).rejects.toThrow('unknown top-level field "bogusField"');
    expect(manager.execute(args).results[0].error?.message).toBe('unknown top-level field "bogusField"');
    expect(manager.snapshot().tasks).toHaveLength(0);
  });

  it.each([null, 42, {}, []])("rejects a non-string call label: %j", async description => {
    const { tool, manager } = fixture();
    const args = { ...create(), description };
    expect(swarmValidateTaskManageParams(args)).toBe("description must be a string");
    await expect(tool.execute("invalid", args)).rejects.toThrow("description must be a string");
    // Deliberately bypass the static type to exercise malformed runtime input.
    const invalidParams = args as unknown as Params;
    expect(manager.execute(invalidParams).results[0].error?.message).toBe("description must be a string");
    expect(manager.snapshot().tasks).toHaveLength(0);
  });
});
