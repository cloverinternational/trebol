# Prompt-cache prefix audit (Plexus + Trebol prompt assembly)

Audit for TREBOL-326. Question: what breaks prompt caching for Pi requests routed
through the Clover Plexus gateway, and how much does it cost?

Everything below is measured, not assumed. Sources: Plexus SQLite
`request_usage` on `clover-plexus` (read-only), a bounded 4-request canary on the
live route, and deterministic prompt assembly in this repository.

## 0. Provenance and capture integrity

Where the gateway address came from, and which slot answered (2026-10-22):

- `vault/infrastructure/hosts.yml:408-419` **does** carry `plexus_vps` with
  `tailscale_ip: 100.121.114.16` and `tailscale_hostname: clover-plexus`, so the
  address is corroborated by the inventory rather than assumed. The inventory is
  authoritative here; an earlier note that the file lacked a Plexus entry was
  wrong. (The same file also defines `clover_swarmtag_vps`,
  45.32.173.181 / 100.78.17.45, which is not this gateway.)
- Independently confirmed: `tailscale status` maps `100.121.114.16` to
  `clover-plexus`; `ssh luis@100.121.114.16 hostname` returns `clover-plexus` and
  `hostname -I` lists `100.121.114.16`; the Pi client config
  `~/.pi/agent/models.json` uses `baseUrl http://100.121.114.16:4000/v1`.

Blue/green: the live route is **green**, not blue. `GET /health` on port 4000
returns `X-Plexus-Slot: green`, and inside `plexus-proxy`
`/etc/plexus/active-route.conf` holds `set $plexus_slot "green"` /
`set $plexus_upstream "plexus-green:4000"`. Both slots share
`/opt/clover/plexus-data/plexus.db`, and only the routed slot receives proxy
traffic, so there is no partial-capture gap: every request the gateway answers is
recorded once.

The canary rows were located back in `request_usage` to close the loop, all four
with `prompt_tokens = 5,821` and `source_ip = 100.127.108.62`:

| id | time (UTC) | uncached | cached |
|---|---|---|---|
| 633817 | 17:31:32 | 5,821 | 0 |
| 633820 | 17:31:33 | 129 | 5,692 |
| 633824 | 17:31:35 | 5,821 | 0 |
| 633826 | 17:31:36 | 129 | 5,692 |

No capture window was enabled and nothing on the gateway was changed; the canary
is four ordinary completion requests and needed no revert.

## 1. How Plexus reports cache tokens

`request_usage.tokens_input` is the **uncached** input count and
`tokens_cached` is the cached count, so a request's prompt is
`tokens_input + tokens_cached`. Reading `tokens_cached / tokens_input` yields
ratios above 100% and is wrong; every number below uses
`cached / (cached + uncached)`.

## 2. Measured cache-hit rate (2026-10-19 → 2026-10-22, success rows only)

| alias | provider | requests | prompt tokens | cached | hit |
|---|---|---|---|---|---|
| deepseek-flash-latest | fireworks | 1,672 | 261,740,467 | 254,837,062 | **97.4%** |
| glm-5p3-flash | fireworks | 7,712 | 701,242,610 | 637,678,058 | 90.9% |
| sol | codex-oauth-2 | 6,440 | 348,064,801 | 265,805,184 | 76.4% |
| claude-haiku-5-5 | claude-oauth | 3,325 | 329,592,785 | 328,180,916 | 99.6% |
| claude-opus-5-5 | claude-oauth | 1,937 | 351,272,675 | 234,669,598 | 66.8% |
| luna | codex-oauth-2 | 1,317 | 49,045,254 | 19,326,720 | 39.4% |
| astra | codex-oauth-2 | 782 | 88,363,180 | 41,017,344 | 46.4% |
| swarm-main | claude-oauth | 1,459 | 37,862,200 | 0 | **0.0%** |

Per-request distribution for the busiest Pi alias: `deepseek-flash-latest`
median hit **99.3%**, only 4.1% of requests with zero cached tokens, and 9 of
1,552 requests with 10+ messages that re-read their whole prompt. Within a live
session the cached count tracks the previous prompt exactly
(mc=2 → 43,005 uncached; mc=4 → 42,876 cached + 868 new).

Split by the API the client used (5-day window), the picture is not "Pi is broken":

| incoming | provider | outgoing | requests | uncached | cached | hit |
|---|---|---|---|---|---|---|
| messages | claude-oauth | messages | 15,641 | 28,007,685 | 1,193,485,330 | **97.7%** |
| chat | codex-oauth-2 | responses | 11,033 | 189,348,130 | 504,116,096 | 72.7% |
| chat | fireworks | chat | 10,061 | 73,248,244 | 977,292,464 | 93.0% |
| chat | claude-oauth | messages | 2,823 | 162,758,684 | 0 | **0.0%** |

## 3. The one path with no caching at all

`chat → claude-oauth → messages` never produces a cache read: 0 cached tokens on
2,823 requests and 162.8M prompt tokens. The same provider on the native
`messages` path caches at 97.7%. Anthropic only reads a prefix when the request
carries `cache_control` breakpoints, and Pi's `openai-completions` client emits
them only when the model's `compat.cacheControlFormat` is `"anthropic"`
(`vendor/pi-mono/packages/ai/src/providers/openai-completions.ts`,
`buildParams`/`applyAnthropicCacheControl`). A Pi model registered on the
`openai-completions` provider therefore sends no breakpoints, and Plexus does not
add them when it converts chat → Anthropic messages.

This is not the default Pi configuration: `~/.pi/agent/models.json` routes
`claude-*` through `clover-plexus-anthropic` (`api: anthropic-messages`), which
is why Pi's own Claude traffic is at 99.6%. The 0% rows come from a client that
calls a Claude alias in chat format.

## 4. Prefix divergence inside Pi's own system prompt

`request_usage` keeps tokens, not bodies, and `debug_logs` holds 1 row with
`debug.captureOnError = false`, so request bodies cannot be diffed server-side.
The divergence was therefore reproduced deterministically from the assembler in
this repository and confirmed on the live route.

Assembled Forge system prompt for a git workspace, section byte offsets:

```
      0     227 testing-contract
    229     746 workspace          <- <workspace_extensions ... files="N"> at byte 467
    977    8443 forge
   9422    2870 reporting
  12294    5981 delegation
  18277     786 response-check
  19065    5015 context (AGENTS.md)
```

Adding one tracked file changes `git ls-files`, so in a two-file probe repo the
first divergence lands at **byte 543 of a 19,232-byte prompt**: 18,689 downstream
bytes (97.2% of the system prompt) are invalidated. The producer is
`fetchWorkspaceExtensions()` (`extensions/swarm-prompt/extension.ts:149`),
rendered by `renderWorkspaceContext()` and placed in section 2.

Live confirmation on `deepseek-flash-latest` (4 requests, 24,505-byte prefix):

| request | prefix | prompt | cached |
|---|---|---|---|
| P1 cold | census `1002` | 5,821 | 0 |
| P2 identical bytes | census `1002` | 5,821 | **5,692** |
| P3 one digit changed at byte ~60 | census `1003` | 5,821 | **0** |
| P4 identical to P3 | census `1003` | 5,821 | **5,692** |

One byte in the early prefix costs the entire cache; restoring it restores the
hit. Cache read is therefore all-or-nothing on this route, which is why an early
volatile block is expensive out of proportion to its size.

Classification of the known volatile inputs:

- **Changes whenever the prompt is rebuilt**: the git file census, because
  `git ls-files` runs on every assembly. It is 97% blast radius, but the hook's
  own idempotence guard (`assembledPromptKinds`) keeps most turns from
  re-assembling, so the practical frequency is "on re-assembly", not "every
  request".
- **Changes periodically (daily)**: `<currentDate>` — harmless, it is in the
  ephemeral block at the very end.
- **Changes mid-session by design**: the `<available_skills>` catalog, which
  `withSkillCatalog()` prepends at byte 0. Creating or patching a skill during a
  session therefore invalidates 100% of the system prompt. This is deliberate
  (autogenskills must be visible immediately) and is left alone.
- **Stable but ordered per request**: nothing. Tool-schema ordering and the
  message history were measured stable; cached counts track the previous prompt
  exactly.

The fix in this change pins the census to the session snapshot, so the block can
no longer change under a running session. That matches Swarm, which renders the
workspace context once at startup (`sdk_integration_config.go
LoadAndInjectContext`) and only re-runs the *context* injection per request.

## 5. Cost estimate

Assumptions: the prices quoted in TREBOL-326 (uncached input $0.59/M, cached
$0.25/M), 30-day month scaled from the 3-day window.

- `deepseek-flash-latest`, 3 days: 6.9M uncached tokens. At $0.59/M that is
  $4.07 versus $1.73 if the same tokens had been cached — about $2.34, or
  **≈$23/month**. The DeepSeek path is not the expensive problem.
- A single early-prefix invalidation on a 40K-token prompt (the size measured in
  production for a Pi agent with 85 tools) re-bills 40K tokens: $0.0236 at the
  uncached rate versus $0.010 cached, **≈$0.014 per event** on DeepSeek.
- The 0% `chat → claude-oauth` path re-bills 162.8M tokens per 5 days on
  `claude-sonnet-5` at $2/M input (Plexus pricing row 421): **$325 per 5 days,
  ≈$1,950/month**, against roughly 10% of that if the prefix were cached at
  Anthropic's cache-read rate. This is the largest measurable cache loss on the
  gateway.
- `sol`: 20.0M tokens re-billed across 689 prefix breaks in 3 days (14.6% of
  continuing requests) at $2/M is **$40 per 3 days, ≈$400/month**, from the
  `chat → codex-oauth-2 → responses` conversion.

## 6. What could not be verified

- Which client sends the 2,823 `chat → claude-oauth` requests. Source IP
  100.98.35.125 is not a current Tailscale node, and the rows carry no
  attribution. It is not Pi's default Claude route (that path is at 97.7%).
  The same trap exists elsewhere in this estate: on the API VPS a compose-managed
  `clover-hub-api` duplicate can sit idle while traefik routes
  `api.clover4.app` to the blue slot. Before concluding anything about a partial
  capture gap, confirm which container actually serves the route. On Plexus this
  was checked (section 0): the live slot is green and every answered request is
  recorded.
- Whether Plexus drops `cache_control` that a client *did* send, versus the
  client never sending it. Plexus source is not in this repository.
- Mid-session break attribution per event. Without stored bodies, a break can be
  timed but not attributed to a specific component.
- Whether the census actually flips mid-session in production Pi sessions; the
  idempotence guard makes it conditional, and the live sessions sampled did not
  show it.
