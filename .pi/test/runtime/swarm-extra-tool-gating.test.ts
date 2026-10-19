import { describe, expect, it } from "vitest";
import {
  configuredExtraTools,
  gateActiveTools,
  REQUIRED_PI_EXTENSION_TOOLS,
  swarmSurfaceFor,
} from "../../lib/runtime/swarm-tool-gating.ts";

describe("explicit Pi extension tool gating", () => {
  it("surfaces ask_user_question under Tern's TUI without bound UI, but not headless", () => {
    // Regression: Tern runs mode "tui" with hasUI false, so the interactive-only gate hid the ask tool.
    const tern = { interactive: false, remoteAsk: true, home: "/nonexistent", env: {} };
    expect(swarmSurfaceFor(tern).has("ask_user_question")).toBe(true);
    expect(gateActiveTools(["ask_user_question"], tern, {})).toBeUndefined();
    const headless = { interactive: false, home: "/nonexistent", env: {} };
    expect(swarmSurfaceFor(headless).has("ask_user_question")).toBe(false);
    expect(gateActiveTools(["ask_user_question"], headless, {})).toEqual([]);
  });

  it("keeps project_init on the model surface so /init can drive it", () => {
    // Regression: project_init registered but was filtered out of the active
    // set, so the agent reported the tool as missing in a real session.
    const environment = { interactive: true, home: "/nonexistent", env: {} };
    expect(swarmSurfaceFor(environment).has("project_init")).toBe(true);
    expect(gateActiveTools(["project_init"], environment, {})).toBeUndefined();
    // A tool that is genuinely Pi-only must still be hidden.
    expect(gateActiveTools(["project_init", "unlisted_local"], environment, {})).toEqual(["project_init"]);
  });

  it("keeps the tern tool on the model surface so agents can drive Tern browsers and panes", () => {
    const environment = { interactive: false, remoteAsk: true, home: "/nonexistent", env: {} };
    expect(swarmSurfaceFor(environment).has("tern")).toBe(true);
    expect(swarmSurfaceFor(environment).has("tern_browser")).toBe(false);
    expect(gateActiveTools(["tern"], environment, {})).toBeUndefined();
  });

  it("always allows required policy tools and keeps other extras explicit", () => {
    expect(REQUIRED_PI_EXTENSION_TOOLS).toEqual(["change_context", "context_index", "context_remember", "context_reindex", "context_search", "context_outline", "context_read", "context_inspect", "context_delete"]);
    expect([
      ...configuredExtraTools({
        PI_SWARM_EXTRA_TOOLS: " local_a ,,local_a ",
      }),
    ]).toEqual(["local_a"]);

    const env = { PI_SWARM_EXTRA_TOOLS: "missing_local" };
    const surface = swarmSurfaceFor({
      interactive: true,
      home: "/nonexistent",
      env,
    });
    expect(surface.has("change_context")).toBe(true);
    expect(surface.has("missing_local")).toBe(true);
    expect(surface.has("unlisted_local")).toBe(false);

    // The global allowlist can only retain tools that Pi actually registered.
    expect(
      gateActiveTools(
        ["Bash", "change_context", "unlisted_local"],
        { interactive: true, home: "/nonexistent", env },
        env,
      ),
    ).toEqual(["Bash", "change_context"]);

    // A persisted /tools or prompt-context allowlist cannot strand mutation
    // tools without the registered policy tool they require.
    expect(
      gateActiveTools(
        ["Bash"],
        { interactive: true, home: "/nonexistent", env: {} },
        {},
        ["Bash", "change_context"],
      ),
    ).toEqual(["Bash", "change_context"]);
    expect(
      gateActiveTools(
        ["unlisted_local"],
        { interactive: true, home: "/nonexistent", env: {} },
        {},
        ["unlisted_local", "change_context"],
      ),
    ).toEqual(["change_context"]);
    expect(
      gateActiveTools(
        ["Bash"],
        { interactive: true, home: "/nonexistent", env: {} },
        { PI_SWARM_TOOL_SURFACE: "all" },
        ["Bash", "change_context"],
      ),
    ).toEqual(["Bash", "change_context"]);
    // Do not fabricate the policy tool when no extension registered it.
    expect(
      gateActiveTools(
        ["Bash"],
        { interactive: true, home: "/nonexistent", env: {} },
        {},
        ["Bash"],
      ),
    ).toBeUndefined();
  });
});

it("retains selected registered MCP tools without enabling deselected tools", () => {
  const environment = { interactive: true, home: "/nonexistent", env: {}, mcpTools: ["mcp", "plexus_management_status"] };
  expect(gateActiveTools(["mcp", "plexus_management_status", "unlisted_local"], environment, {})).toEqual(["mcp", "plexus_management_status"]);
  expect(gateActiveTools(["Bash"], environment, {}, ["Bash", "mcp"])).toBeUndefined();
});
