import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  encodeWav16,
  RemoteAsrBackend,
  remoteAsrConfig,
  type RemoteAsrConfig,
} from "../src/remote-asr.js";

type Recorded = { url: string; body: string };
type TestServer = { url: string; requests: Recorded[]; close(): Promise<void> };

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("latin1");
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function start(
  handler: (request: IncomingMessage, payload: string, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: Recorded[] = [];
  const server = createServer(async (request, response) => {
    const payload = await body(request);
    requests.push({ url: request.url ?? "", body: payload });
    handler(request, payload, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function config(
  endpoints: RemoteAsrConfig["endpoints"],
  overrides: Partial<RemoteAsrConfig> = {},
): RemoteAsrConfig {
  return {
    endpoints,
    model: "nvidia/parakeet-tdt-0.6b-v3",
    probeTimeoutMs: 500,
    requestTimeoutMs: 2_000,
    // Tests assert call order, so a failure must not hide an endpoint.
    retryBackoffMs: 0,
    ...overrides,
  };
}

const pcm = (): Float32Array => Float32Array.of(0.1, -0.1, 0.2);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("defaults allow a slow connect and keep LAN first", () => {
  const defaults = remoteAsrConfig({});
  assert.equal(defaults?.probeTimeoutMs, 5_000);
  assert.deepEqual(defaults?.endpoints.map((endpoint) => endpoint.name), [
    "lan",
    "tailscale",
  ]);
});

test("encodes capture PCM as a 16 kHz mono 16-bit WAV", () => {
  const wav = encodeWav16(Float32Array.of(0, 1, -1));
  const view = new DataView(wav.buffer);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString("ascii"), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32_767);
  assert.equal(view.getInt16(48, true), -32_767);
});

test("uses the LAN endpoint when it is reachable", async () => {
  const lan = await start((request, _payload, response) => {
    if (request.url === "/transcribe") return json(response, { text: "hello from LAN" });
    response.statusCode = 404;
    response.end();
  });
  try {
    const backend = new RemoteAsrBackend(config([{ name: "lan", url: lan.url }]));
    assert.equal(await backend.transcribe(pcm()), "hello from LAN");
    assert.equal(backend.lastEndpoint?.name, "lan");
    assert.deepEqual(lan.requests.map((request) => request.url), ["/transcribe"]);
  } finally {
    await lan.close();
  }
});

test("falls back to Tailscale when the LAN address refuses connections", async () => {
  const tailscale = await start((request, _payload, response) => {
    return json(response, { text: "hello from Tailscale" });
  });
  try {
    const backend = new RemoteAsrBackend(config([
      { name: "lan", url: "http://127.0.0.1:1" },
      { name: "tailscale", url: tailscale.url },
    ]));
    assert.equal(await backend.transcribe(pcm()), "hello from Tailscale");
    assert.equal(backend.lastEndpoint?.name, "tailscale");
    assert.deepEqual(tailscale.requests.map((request) => request.url), ["/transcribe"]);
  } finally {
    await tailscale.close();
  }
});

test("falls back when the LAN request returns 500", async () => {
  const lan = await start((request, _payload, response) => {
    json(response, { detail: "model crashed" }, 500);
  });
  const tailscale = await start((request, _payload, response) => {
    return json(response, { text: "second endpoint" });
  });
  try {
    const backend = new RemoteAsrBackend(config([
      { name: "lan", url: lan.url },
      { name: "tailscale", url: tailscale.url },
    ]));
    assert.equal(await backend.transcribe(pcm()), "second endpoint");
    assert.equal(backend.lastEndpoint?.name, "tailscale");
  } finally {
    await lan.close();
    await tailscale.close();
  }
});

test("reports both endpoints when neither can transcribe", async () => {
  const backend = new RemoteAsrBackend(config([
    { name: "lan", url: "http://127.0.0.1:1" },
    { name: "tailscale", url: "http://127.0.0.1:2" },
  ]));
  await assert.rejects(
    backend.transcribe(pcm()),
    (error: Error) => {
      assert.match(error.message, /Remote transcription failed on every endpoint/);
      assert.match(error.message, /lan/);
      assert.match(error.message, /tailscale/);
      return true;
    },
  );
});

test("a connect that exceeds its budget falls through instead of failing the take", async () => {
  // TEST-NET-1 is never routed, so the connect can only end in this timeout.
  const tailscale = await start((request, _payload, response) => {
    return json(response, { text: "tailscale text" });
  });
  try {
    const backend = new RemoteAsrBackend(config([
      { name: "lan", url: "http://192.0.2.1:8001" },
      { name: "tailscale", url: tailscale.url },
    ], { probeTimeoutMs: 50 }));
    assert.equal(await backend.transcribe(pcm()), "tailscale text");
    assert.equal(backend.lastEndpoint?.name, "tailscale");
  } finally {
    await tailscale.close();
  }
});

test("a recently failed endpoint waits behind a healthy one", async () => {
  const lan = await start((request, _payload, response) => {
    json(response, { detail: "not ready" }, 503);
  });
  const tailscale = await start((request, _payload, response) => {
    return json(response, { text: "tailscale text" });
  });
  try {
    const backend = new RemoteAsrBackend(config([
      { name: "lan", url: lan.url },
      { name: "tailscale", url: tailscale.url },
    ], { retryBackoffMs: 60_000 }));

    assert.equal(await backend.transcribe(pcm()), "tailscale text");
    // The failing LAN was paid for once; the next take skips it entirely.
    assert.deepEqual(lan.requests.map((request) => request.url), ["/transcribe"]);

    assert.equal(await backend.transcribe(pcm()), "tailscale text");
    assert.deepEqual(lan.requests.map((request) => request.url), ["/transcribe"]);
    assert.deepEqual(
      tailscale.requests.map((request) => request.url),
      ["/transcribe", "/transcribe"],
    );
  } finally {
    await lan.close();
    await tailscale.close();
  }
});

test("an endpoint is preferred again once its backoff expires", async () => {
  let lanReady = false;
  const lan = await start((request, _payload, response) => {
    if (!lanReady) return json(response, { detail: "not ready" }, 503);
    return json(response, { text: "lan text" });
  });
  const tailscale = await start((request, _payload, response) => {
    return json(response, { text: "tailscale text" });
  });
  try {
    const backend = new RemoteAsrBackend(config([
      { name: "lan", url: lan.url },
      { name: "tailscale", url: tailscale.url },
    ], { retryBackoffMs: 40, retryBackoffMaxMs: 40 }));

    assert.equal(await backend.transcribe(pcm()), "tailscale text");
    lanReady = true;
    await delay(60);
    assert.equal(await backend.transcribe(pcm()), "lan text");
    assert.equal(backend.lastEndpoint?.name, "lan");
  } finally {
    await lan.close();
    await tailscale.close();
  }
});

test("a pinned language uses the OpenAI route; auto uses the native route", async () => {
  const server = await start((request, _payload, response) => {
    if (request.url === "/health") return json(response, { status: "ok" });
    return json(response, { text: "ok" });
  });
  try {
    const backend = new RemoteAsrBackend(config([{ name: "lan", url: server.url }]));
    await backend.transcribe(pcm(), { language: "es" });
    assert.equal(server.requests.at(-1)?.url, "/v1/audio/transcriptions");
    assert.match(server.requests.at(-1)?.body ?? "", /name="model"/);
    assert.match(server.requests.at(-1)?.body ?? "", /name="language"/);
    assert.match(server.requests.at(-1)?.body ?? "", /\r\n\r\nes\r\n/);

    await backend.transcribe(pcm());
    assert.equal(server.requests.at(-1)?.url, "/transcribe");
    assert.doesNotMatch(server.requests.at(-1)?.body ?? "", /name="language"/);
  } finally {
    await server.close();
  }
});
