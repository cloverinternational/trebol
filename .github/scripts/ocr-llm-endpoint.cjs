#!/usr/bin/env node
// Resolve the OpenCodeReview LLM endpoint for a given protocol.
//
// The `ocr` binary derives its HTTP path from the base URL it is given, and the
// two protocols disagree about what "base" means:
//
//   openai    -> OpenAI SDK: base + "/chat/completions"
//   anthropic -> Anthropic SDK: base + "/v1/messages"
//
// Upstream (internal/llm/client.go) therefore trims a trailing "/v1/messages"
// or "/chat/completions" from OCR_LLM_URL before handing it to the SDKs, but it
// does NOT strip a trailing "/v1". A gateway URL that works for the OpenAI
// protocol (…:4000/v1) would make the Anthropic client call
// …:4000/v1/v1/messages. Normalizing here keeps one repository variable usable
// for both protocols.
//
// Usage as a library:
//   const { resolveLlmEndpoint } = require("./ocr-llm-endpoint.cjs");
// Usage as a CLI (prints the normalised URL, or exits non-zero with a message):
//   node .github/scripts/ocr-llm-endpoint.cjs <url> <protocol>

"use strict";

const SUPPORTED_PROTOCOLS = ["openai", "anthropic"];

/**
 * @param {{ url?: string, protocol?: string }} input
 * @returns {{ url: string, protocol: string }}
 */
function resolveLlmEndpoint(input) {
  const rawProtocol = typeof input?.protocol === "string" ? input.protocol.trim().toLowerCase() : "";
  if (!SUPPORTED_PROTOCOLS.includes(rawProtocol)) {
    throw new Error(
      `unsupported OCR_LLM_PROTOCOL ${JSON.stringify(input?.protocol ?? "")}; ` +
        `supported protocols are ${SUPPORTED_PROTOCOLS.map((p) => JSON.stringify(p)).join(", ")}`,
    );
  }

  let url = typeof input?.url === "string" ? input.url.trim() : "";
  if (url.length === 0) {
    throw new Error("OCR_LLM_URL is empty");
  }
  if (!/^https?:\/\/[^/\s]+/i.test(url)) {
    throw new Error(`OCR_LLM_URL must be an absolute http(s) URL, got ${JSON.stringify(url)}`);
  }
  if (/[\r\n]/.test(url)) {
    throw new Error("OCR_LLM_URL must not contain newlines");
  }

  url = url.replace(/\/+$/, "");
  // A full endpoint may be pasted instead of a base. Strip at most one suffix,
  // comparing case-insensitively, so "/chat/completions" can never be followed
  // by a second strip of a fragment it revealed.
  const lowered = url.toLowerCase();
  const suffix = ["/chat/completions", "/v1/messages"].find((candidate) => lowered.endsWith(candidate));
  if (suffix) {
    url = url.slice(0, -suffix.length);
  }
  // The Anthropic SDK appends "/v1/messages" itself, so a trailing "/v1" left
  // over from OpenAI-style configuration would be duplicated.
  if (rawProtocol === "anthropic" && url.toLowerCase().endsWith("/v1")) {
    url = url.slice(0, -"/v1".length);
  }
  url = url.replace(/\/+$/, "");

  if (!/^https?:\/\/[^/\s]+/i.test(url)) {
    throw new Error(`OCR_LLM_URL has no host after normalization: ${JSON.stringify(input?.url ?? "")}`);
  }

  return { url, protocol: rawProtocol };
}

module.exports = { resolveLlmEndpoint, SUPPORTED_PROTOCOLS };

if (require.main === module) {
  const [url, protocol] = process.argv.slice(2);
  try {
    process.stdout.write(resolveLlmEndpoint({ url, protocol }).url);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
