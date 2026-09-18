import { expect, it } from "vitest";
import { applySwarmSurface, overlaySwarmToolSchemas } from "../../lib/runtime/swarm-tool-surface.ts";

it("uses adapted descriptions at registration and on both provider wire shapes", () => {
  for (const name of ["SkillManage", "ask_user_question", "SubagentOutput"]) {
    const registered = applySwarmSurface({ name, description: "" });
    expect(registered.description).not.toBe("");
    expect(registered.description).not.toContain("ONLY correct way");
    expect(registered.description).not.toContain("Do NOT use in the middle");
    const openai = overlaySwarmToolSchemas({ tools: [{ function: { name, description: "old" } }] });
    const anthropic = overlaySwarmToolSchemas({ tools: [{ name, description: "old", input_schema: {} }] });
    expect(openai?.tools[0].function.description).toBe(registered.description);
    expect(anthropic?.tools[0].description).toBe(registered.description);
  }
});

it("advertises mandatory task questions and answers on both wire protocols",()=>{
 const a=overlaySwarmToolSchemas({tools:[{function:{name:"TaskManage",parameters:{}}}]})!;
 const b=overlaySwarmToolSchemas({tools:[{name:"TaskManage",input_schema:{}}]})!;
 const schema:any=a.tools[0].function.parameters;
 expect(schema.properties.operations.items.properties.questions.minItems).toBe(1);
 expect(schema.properties.operations.items.properties.answers).toBeDefined();
 expect(b.tools[0].input_schema).toEqual(schema);
});
