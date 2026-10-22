import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The OCR workflow runs this module with plain node, so it stays CommonJS and is
// loaded here through require rather than converted to TypeScript.
const require_ = createRequire(import.meta.url);
const scriptPath = join(process.cwd(), ".github/scripts/ocr-llm-endpoint.cjs");
const { resolveLlmEndpoint, SUPPORTED_PROTOCOLS } = require_(scriptPath) as {
  resolveLlmEndpoint: (input: { url?: string; protocol?: string }) => { url: string; protocol: string };
  SUPPORTED_PROTOCOLS: string[];
};

describe("OCR LLM endpoint resolution", () => {
  it("keeps the /v1 base the OpenAI SDK expects", () => {
    expect(resolveLlmEndpoint({ url: "http://100.121.114.16:4000/v1", protocol: "openai" })).toEqual({
      url: "http://100.121.114.16:4000/v1",
      protocol: "openai",
    });
  });

  it("strips /v1 for the Anthropic SDK so it does not call /v1/v1/messages", () => {
    expect(resolveLlmEndpoint({ url: "http://100.121.114.16:4000/v1", protocol: "anthropic" }).url).toBe(
      "http://100.121.114.16:4000",
    );
  });

  it("accepts full endpoint URLs and trailing slashes for both protocols", () => {
    expect(resolveLlmEndpoint({ url: "http://host:4000/v1/chat/completions", protocol: "openai" }).url).toBe(
      "http://host:4000/v1",
    );
    expect(resolveLlmEndpoint({ url: "http://host:4000/v1/messages/", protocol: "anthropic" }).url).toBe(
      "http://host:4000",
    );
    expect(resolveLlmEndpoint({ url: "  http://host:4000/  ", protocol: "openai" }).url).toBe("http://host:4000");
  });

  it("does not strip a /v1 that is part of the host path for a non-versioned base", () => {
    expect(resolveLlmEndpoint({ url: "https://gateway.example/plexus/v1", protocol: "anthropic" }).url).toBe(
      "https://gateway.example/plexus",
    );
  });

  it("rejects unsupported protocols and empty URLs loudly", () => {
    expect(() => resolveLlmEndpoint({ url: "http://host:4000", protocol: "openai-responses" })).toThrow(
      /unsupported OCR_LLM_PROTOCOL/,
    );
    expect(() => resolveLlmEndpoint({ url: "", protocol: "openai" })).toThrow(/OCR_LLM_URL is empty/);
    expect(SUPPORTED_PROTOCOLS).toEqual(["openai", "anthropic"]);
  });

  it("exposes the same behaviour on the command line", () => {
    const out = execFileSync("node", [scriptPath, "http://100.121.114.16:4000/v1", "anthropic"], {
      encoding: "utf8",
    });
    expect(out).toBe("http://100.121.114.16:4000");
  });
});
