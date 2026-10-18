import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptExtension from "../../../extensions/swarm-prompt/extension.ts";
import systemPromptsExtension, {
  FORGE_PROMPT,
  PI_DEFAULT_PROMPT,
  resolveActiveSystemPrompt,
  savePromptStore,
} from "../../../extensions/system-prompts/extension.ts";
import { registerSystemInspector } from "../../../extensions/system-inspector/extension.ts";

function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands: string[] = [];
  return {
    handlers,
    commands,
    pi: {
      on(event: string, handler: (event: any, ctx: any) => any) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand(name: string) { commands.push(name); },
    },
  };
}

describe("system-prompt ownership", () => {
  it("inspects the actual checkout and flat manifest after relocation", async () => {
    let command: any; let output = "";
    registerSystemInspector({ registerCommand: (_name: string, spec: any) => { command = spec; } });
    await command.handler("", { cwd: process.cwd(), ui: { editor: async (_title: string, text: string) => { output = text; } } });
    expect(output).toContain("@pi-swarm/core (packages/runtime/core)");
    expect(output).toContain("mcp-fallback");
    expect(output).toContain("swarm-agent-tools");
    expect(output).not.toContain("00-runtime/");
  });
  it("keeps mutation in swarm-prompt while system-prompts is UI-only", () => {
    const prompt = fakePi();
    const picker = fakePi();
    promptExtension(prompt.pi as any);
    systemPromptsExtension(picker.pi as any);

    expect(prompt.handlers.get("before_agent_start")).toHaveLength(1);
    expect(picker.handlers.has("before_agent_start")).toBe(false);
    expect(picker.commands).toEqual(["sp"]);
  });

  it("defaults a new workspace to the Modes prompt", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-owner-"));
    expect(resolveActiveSystemPrompt(cwd)).toMatchObject({ kind: "modes" });
  });

  it("preserves Pi's appended system prompt when Forge replaces the base", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-addendum-"));
    savePromptStore(cwd, { prompts: [], active: FORGE_PROMPT });
    const runtime = fakePi(); promptExtension(runtime.pi as any);
    const handler = runtime.handlers.get("before_agent_start")![0];
    const appended = "The secret codeword is ZETA-8801.";
    const options = { cwd, appendSystemPrompt: appended };
    const result: any = await handler({ systemPrompt: `Pi base\n\n<addendum>\n${appended}\n</addendum>`, systemPromptOptions: options }, { cwd, hasUI: false });
    expect(result.systemPrompt).toContain("# Delegation (the Task tool)");
    expect(result.systemPrompt).not.toContain("Pi base");
    expect(result.systemPrompt.match(/<addendum>\nThe secret codeword is ZETA-8801\.\n<\/addendum>/g)).toHaveLength(1);
    const noAppend: any = await handler({ systemPrompt: "Pi base", systemPromptOptions: { cwd } }, { cwd, hasUI: false });
    expect(noAppend.systemPrompt).not.toContain("<addendum>");
    const empty: any = await handler({ systemPrompt: "Pi base", systemPromptOptions: { cwd, appendSystemPrompt: "" } }, { cwd, hasUI: false });
    expect(empty.systemPrompt).not.toContain("<addendum>");
  });

  it("delivers footer guidance with natural requests but not unrelated or Pi-base requests", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-footer-guidance-"));
    savePromptStore(cwd, { prompts: [], active: FORGE_PROMPT });
    const runtime = fakePi(); promptExtension(runtime.pi as any);
    const handler = runtime.handlers.get("before_agent_start")![0];
    const question = "Help me improve the footer. Explain how each visible part works.";
    const selected: any = await handler({ systemPrompt: "Pi base", prompt: question, systemPromptOptions: { cwd } }, { cwd, hasUI: true });
    expect(selected?.message?.content).toContain("FIRST complete answer");
    expect(selected?.systemPrompt).toContain("[FIRST RESPONSE EXPLANATION CHECK]");
    const unrelated: any = await handler({ systemPrompt: "Pi base", prompt: "Fix a test", systemPromptOptions: { cwd } }, { cwd, hasUI: true });
    expect(unrelated?.message).toBeUndefined();
    savePromptStore(cwd, { prompts: [], active: PI_DEFAULT_PROMPT });
    const piBase: any = await handler({ systemPrompt: "Pi base", prompt: question, systemPromptOptions: { cwd } }, { cwd, hasUI: true });
    expect(piBase?.message).toBeUndefined();
  });

  it("honors the explicit Pi-base selection", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-owner-"));
    savePromptStore(cwd, { prompts: [], active: PI_DEFAULT_PROMPT });
    expect(resolveActiveSystemPrompt(cwd)).toEqual({ kind: "pi" });

    const runtime = fakePi();
    promptExtension(runtime.pi as any);
    const handler = runtime.handlers.get("before_agent_start")![0];
    const result: any = await handler({ systemPrompt: "Pi base", systemPromptOptions: { cwd } }, {});
    expect(result.systemPrompt).toContain("Pi base");
    expect(result.systemPrompt).toContain("<available_skills>");
  });

  it("migrates the old active-undefined representation as Pi base", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-owner-"));
    const storePath = join(cwd, ".pi", "system-prompts.json");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(storePath, JSON.stringify({ prompts: [] }));
    expect(resolveActiveSystemPrompt(cwd)).toEqual({ kind: "pi" });
  });

  it("honors a custom prompt, including an override with Forge's display name", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-owner-"));
    savePromptStore(cwd, {
      prompts: [{ name: FORGE_PROMPT, content: "custom Forge override" }],
      active: FORGE_PROMPT,
    });
    expect(resolveActiveSystemPrompt(cwd)).toEqual({
      kind: "custom",
      name: FORGE_PROMPT,
      content: "custom Forge override",
    });

    const runtime = fakePi();
    promptExtension(runtime.pi as any);
    const handler = runtime.handlers.get("before_agent_start")![0];
    const result: any = await handler({ systemPrompt: "Pi base", systemPromptOptions: { cwd } }, {});
    expect(result.systemPrompt).toContain("custom Forge override");
    expect(result.systemPrompt).toContain("<available_skills>");
  });

  it("keeps the assembled prompt out of the transcript until the header expands", async () => {
    let headerFactory: ((tui: any, theme: any) => any) | undefined;
    const entries: unknown[] = [];
    const runtime: any = {
      getCwd: () => process.cwd(),
      getAllTools: () => [],
      on: (event: string, handler: (value: any, ctx: any) => any) => {
        if (event === "before_agent_start") runtime.beforeAgentStart = handler;
        if (event === "session_start") runtime.sessionStart = handler;
      },
      appendEntry: (...value: unknown[]) => entries.push(value),
      registerCommand: () => {},
    };
    registerSystemInspector(runtime);
    await runtime.beforeAgentStart({ systemPrompt: "assembled system prompt" }, { cwd: process.cwd() });
    expect(entries).toEqual([]);

    await runtime.sessionStart({}, { cwd: process.cwd(), ui: { setHeader: (factory: any) => { headerFactory = factory; } } });
    expect(headerFactory).toBeTypeOf("function");
    const component: any = headerFactory!({}, { fg: (_color: string, text: string) => text });
    expect(component.render(80).join("\n")).toBe("");
    component.setExpanded(true);
    expect(component.render(80).join("\n")).toContain("SYSTEM PROMPT");
  });
});
