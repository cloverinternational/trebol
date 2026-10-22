# The 0% cache path: `chat → claude-oauth → messages`

Follow-up to [prompt-cache-prefix-audit.md](prompt-cache-prefix-audit.md)
(TREBOL-326, fix in PR #340). That audit could not say which side of the
gateway was responsible for the one route that never caches. This one can,
because the client turned out to be our own CI, and the payload was therefore
reproducible instead of guessed.

Everything below is measured on the live gateway on 2026-10-22 (UTC). The
gateway was read-only apart from one reverted setting flip described in
§2.3 and one row-level config change described in §6.

## 0. Answer

The 2,823–3,400 requests on `chat → claude-oauth → messages` come from
**OpenCodeReview running in GitHub Actions** (`api_key = github-ocr`, model
`claude-sonnet-5`). Its client never sends `cache_control`, because the
workflow forces `OCR_LLM_PROTOCOL=openai` and OCR's OpenAI request builder
cannot express the field at all.

Plexus is not the cause of this route's 0%, but it is not innocent either: it
**preserves `cache_control` on `tools[]` and `messages[].content[]` and silently
drops it from `system[]`**. So the canonical Anthropic pattern — one breakpoint
on the system block — does not work through this gateway, and any client that
relies on it caches nothing.

Fix shipped here: the workflow now speaks the Anthropic protocol to Plexus
(breakpoints land on the last message and last tool, which survive), with the
base URL normalised in one tested helper. Measured effect on the same client and
the same prompt: **23,188 uncached tokens → 8,869 cached reads + 14,479 cache
writes**, i.e. 0% → 27.5% of prompt tokens served from cache on a one-file
review, and it grows with review size.

## 1. Attribution

`request_usage.api_key` stores the API key **name**, not the secret, so the
dimension is directly readable. Grouping the problematic route by
`api_key / incoming_api_type / provider / selected_model_name`:

| incoming | provider | model | api_key | requests | uncached | cached | cache_write |
|---|---|---|---|---|---|---|---|
| chat | claude-oauth | claude-sonnet-5 | **github-ocr** | 3,315 | 97.2M | 0 | 0 |
| chat | claude-oauth | claude-opus-5-5 | pi-robert | 621 | 95.2M | 0 | 0 |
| messages | claude-oauth | claude-haiku-5-5 | luis-pi | 12,961 | 3.3M | 794.6M | 84.2M |
| messages | claude-oauth | claude-opus-5-5 | luis-pi | 2,858 | 24.7M | 398.9M | 22.9M |

(window 2026-10-17 → 2026-10-22)

The name resolves to a single client:

- `api_keys` row 2 is `github-ocr`, comment *"GitHub OpenCodeReview client
  key"*, and its `allowed_models` are exactly `["swarm-main",
  "deepseek-flash-latest"]` — nothing else in the estate uses that key.
- The alias it asks for, `swarm-main`, targets `claude-oauth/claude-sonnet-5`
  (`model_alias_targets` rows 186–189), which is why the route ends in
  `… → messages`.
- The client is `.github/workflows/ocr-review.yml` in this repository: it joins
  the tailnet with `tailscale/github-action` and `secrets.TS_OCR_AUTHKEY`
  (tag `tag:github-ocr`), then runs `ocr review` against
  `vars.OCR_LLM_URL` with `OCR_LLM_PROTOCOL=openai`.

Source IPs are the ephemeral Tailscale nodes that action creates:

| evidence | detail |
|---|---|
| 112 distinct `source_ip` values on the path | one per workflow run |
| `tailscale status` today | `100.64.155.99 github-runnervm8k3b6 tag:github-ocr`, `100.108.114.121 github-runnervm8k3b6-1` |
| earlier today | the same node appeared as `100.77.223.23`; ephemeral nodes get a fresh 100.x address on every registration |
| node lifetime | 1–25 minutes per IP, matching a runner job |

**100.98.35.125** — the address the previous audit could not place — is one of
those runner nodes. All 107 of its requests are `api_key=github-ocr`,
`chat → claude-oauth → claude-sonnet-5`, between 17:22:27 and 17:26:12 on
2026-10-22. It is a Tailscale CGNAT address (`100.64.0.0/10`) that no longer
appears in `tailscale status` because the runner shut down and Tailscale removed
the ephemeral node. It was never an external client.

The `172.18.0.1` / `172.20.0.1` sources on the same route are the docker bridge
addresses of the slot container before `plexus-proxy` existed; they stop on
2026-10-11, the day the proxy was created. Nothing on this route is external.

## 2. Payload truth: does the client send `cache_control`?

### 2.1 The client's code

`@alibaba-group/open-code-review@1.9.8` (pinned in
`.github/ocr-runtime/package.json`) has two request builders:

- `buildAnthropicParams` (`internal/llm/client.go:1100-1218`) sets
  `cache_control: {type: "ephemeral"}` on the **last system block**
  (`client.go:1194`), the **last tool** (`client.go:1198`) and the **last message
  block** (`client.go:1209-1214`).
- `buildOpenAIParams` (`internal/llm/client.go:616-683`) encodes every message as
  a plain string — `openai.SystemMessage(content)` at `client.go:624`. The
  OpenAI Chat Completions schema has no place for `cache_control`.

The workflow forces the second one
(`OCR_LLM_PROTOCOL=openai`, checked in the old preflight step), so **the client
sends no breakpoint at all**. There is nothing for Plexus to preserve.

### 2.2 The gateway's accounting agrees

Across the whole life of the route, `tokens_cache_write` is 0 on every row:

| path | rows | `tokens_cache_write` | `tokens_cached` |
|---|---|---|---|
| chat → claude-oauth (2026-07-31 → 2026-10-22) | 14,349 | **0** | **0** |
| messages → claude-oauth (same window) | 15,820 (5-day slice) | 107.1M | 1,193.5M |

Anthropic reports `cache_creation_input_tokens` whenever it *honours* a
breakpoint, so a write count of zero over 14,349 requests with a 23K-token
median prompt is positive evidence that the upstream request carried none.

### 2.3 What a deliberate capture added

`debug.captureOnError` is `false` (the only row in `system_settings`) and
`debug_logs` holds one unrelated row, so bodies are not stored. A bounded
capture was attempted anyway: the setting was flipped to `true`, three canary
requests were sent that fail *at* the upstream (`temperature` is rejected for
`claude-sonnet-5`), and the setting was restored to `{"value":false}` in the
same minute. `debug_logs` did not grow (still 1 row), so Plexus does not capture
upstream 4xx — the capture channel is dead for this error class and no rows were
left behind to delete. The exact revert was `update system_settings set
value='{"value":false}' where key='debug.captureOnError'`, verified afterwards.

Payload truth therefore comes from the client's source and from a controlled
differential against the live route instead of from a captured body.

## 3. Gateway config review

`plexus-proxy` mounts `/opt/clover/plexus/blue-green/nginx.conf` read-only as
`/etc/nginx/nginx.conf`; the route file `/opt/clover/plexus/blue-green/active-route.conf`
holds `set $plexus_slot "green"` / `set $plexus_upstream "plexus-green:4000"`.
The nginx layer cannot alter a payload:

| file:line | directive | consequence |
|---|---|---|
| `nginx.conf:37` | `proxy_request_buffering off;` | the body is streamed, never assembled or re-serialised |
| `nginx.conf:38` | `proxy_buffering off;` | the response is streamed back unchanged |
| `nginx.conf:30-33` | `proxy_set_header Connection/Host/X-Forwarded-*` | only these are added; other client headers (including `Authorization`, `anthropic-beta`) pass through untouched |
| `nginx.conf:39` | `proxy_pass http://$plexus_upstream;` | no URI part and no rewrite, so the path and query reach the slot as sent |
| `nginx.conf:19-20` | `log_format plexus_safe … $body_bytes_sent` | the access log records the body *length* only; no body, header or credential is logged, and no directive anywhere in the file parses JSON |

So the nginx hop is transparent by construction. The transformation happens in
the Plexus application, and it was measured rather than read, because the Plexus
source is not in this repository (`cloverinternational/plexus` returns 404 from
this account; the running image embeds only the vendored `pi-ai` sources).

Differential measured through the live green slot, `claude-haiku-5-5`, one
45K-token prompt, identical body sent twice (nonce-stable text, back-to-back):

| breakpoint placement | first request | second request |
|---|---|---|
| `system[].cache_control` only | in 131,039 / cw 0 | in 131,039 / cr 0 |
| `system[].cache_control` (small prompt) | in 12,572 / cw 0 | in 12,572 / cr 0 |
| `tools[].cache_control` (last tool) only | in 44,683 / cr 544 / cw 0 | in 44,683 / cr 544 |
| `messages[].content[].cache_control` (last block) | in 4 / **cw 44,611** | in 4 / **cr 44,611** |
| system + last tool + last message (OCR's Anthropic shape) | in 2 / **cw 45,303** | in 2 / **cr 45,303** |

Reading: **`system[]` breakpoints are discarded; `tools[]` and `messages[]`
breakpoints are honoured.** The gateway neither adds nor rewrites breakpoints of
its own — which is why the native `messages` path caches at 97.7% (Pi sends its
own breakpoints, and its last-message breakpoint survives) while `chat →
claude-oauth` cannot cache even when asked to.

## 4. Differential test: same client, same prompt, both paths

`claude-sonnet-5` through the live gateway, one client on one machine, the same
45,305-token prompt in both arms, `cache_control` present or absent as stated:

| arm | incoming | breakpoints on the request | uncached | cache_read | cache_write |
|---|---|---|---|---|---|
| A1 `openai` protocol shape (today) | `/v1/chat/completions` | none | 45,305 | 0 | 0 |
| A2 same body again | `/v1/chat/completions` | none | 45,305 | 0 | 0 |
| B1 `anthropic` protocol shape | `/v1/messages` | system + last tool + last message | 2 | 0 | 45,303 |
| B2 same body again | `/v1/messages` | same | 2 | 45,303 | 0 |

And with the real client, not a hand-built body — `ocr review` of the same
one-file change, same model, same key, `--concurrency 2`:

| client config | requests | input tokens | cache_read | cache_write | client-reported |
|---|---|---|---|---|---|
| `OCR_LLM_PROTOCOL=openai`, URL `…:4000/v1` | 3 | 23,188 | 0 | 0 | `input_tokens 23188` |
| `OCR_LLM_PROTOCOL=anthropic`, URL `…:4000` | 5 | 45,323 | 8,869 | 16,624 | `cache_read_tokens 8869`, `cache_write_tokens 14479` |

Both arms were confirmed independently in `request_usage`, not just from the
client's own summary.

Direct-to-Anthropic without Plexus was not run: the only Claude credential on
this estate is the OAuth token stored encrypted in `oauth_credentials`, and
using it outside the gateway would have meant handling a live subscription token
to save a measurement the table above already isolates (the gateway's own
provider code path is what B1/B2 go through). It is listed as an open item in
§7 rather than glossed over.

## 5. Cost

Measured on the `github-ocr → claude-oauth` path from `request_usage`
(`cost_input` + `cost_total`, `claude-sonnet-5` at $2.00/M input as Plexus
records it):

| day | requests | uncached tokens | cost |
|---|---|---|---|
| 2026-10-18 | 577 | 23.8M | $52.16 |
| 2026-10-19 | 164 | 4.7M | $11.41 |
| 2026-10-21 | 575 | 16.5M | $39.99 |
| 2026-10-22 (partial, to 18:20) | 2,084 | 53.7M | $130.67 |
| **5-day total** | **3,400** | **98.7M** | **$234.24** |

That is ≈**$1,400/month** at the trailing 5-day rate, and ≈**$3,900/month** at
today's rate — the range the previous audit bounded as "$1,950/month".

With 27.5% of prompt tokens served as cache reads and 20% written (the measured
single-file ratio), input cost per token drops from $2.00/M to $1.60/M, about
**20%**: ≈**$280/month** at the trailing rate, ≈**$780/month** at today's rate.
The ratio grows with review size, because every later turn in a review loop
reads the whole earlier prefix from cache, so these are conservative floors.

## 6. The fix

Client side, in this repository, because that is where the breakpoint is
missing:

- `.github/scripts/ocr-llm-endpoint.cjs` normalises `OCR_LLM_URL` per protocol.
  OCR hands the URL straight to the Anthropic SDK, which appends `/v1/messages`
  itself, so the `…/v1` base that the OpenAI SDK needs would become
  `/v1/v1/messages`.
- `.github/workflows/ocr-review.yml` validates the pairing instead of forcing
  `openai`, exports the normalised URL through `GITHUB_ENV`, and records the
  reasoning next to the step.
- `tests/ocr-llm-endpoint.test.ts` pins the normalisation for both protocols and
  the failure modes.

Operational changes (all reversible, none touching another route):

1. `OCR_LLM_PROTOCOL`: `openai` → `anthropic`.
2. `OCR_LLM_MODEL`: `swarm-main` → `claude-sonnet-5`. Needed because
   `swarm-main` resolves to `codex-oauth-2/gpt-5.6-luna` for `messages`-shaped
   requests (measured), and codex ignores these breakpoints; `claude-sonnet-5`
   is the model this path already uses, so behaviour is unchanged.
3. `api_keys.allowed_models` for `github-ocr`: add `claude-sonnet-5`
   (was `["swarm-main","deepseek-flash-latest"]`).

Revert, in reverse order:

```sql
update api_keys     set allowed_models='["swarm-main","deepseek-flash-latest"]' where name='github-ocr';
```

```bash
gh variable set OCR_LLM_MODEL    --body swarm-main -R cloverinternational/trebol
gh variable set OCR_LLM_PROTOCOL --body openai     -R cloverinternational/trebol
```

`OCR_LLM_URL` is unchanged; the helper derives the right base from it for
whichever protocol is configured.

Gateway side, for the Plexus owners: preserving `cache_control` on `system[]`
blocks would let any Anthropic-shaped client cache through this gateway without
the message-block workaround. The reproduction is the §3 table — identical
bodies, one field moved, `cache_creation_input_tokens` flips from 0 to 44,611.

## 7. Still unknown

- Why Plexus drops only `system[]` breakpoints. The behaviour is measured, the
  cause is not: `cloverinternational/plexus` is not reachable from this account,
  so its request assembly could not be read.
- Direct-to-Anthropic control (§4). The credential needed for it is a live
  subscription token; the comparison was made against the gateway's own
  passthrough instead.
- The second 0% contributor: `pi-robert` sends 621 requests / 95.2M uncached
  tokens on the same `chat → claude-oauth` route using `claude-opus-5-5`. That
  is a Pi client configured with an `openai-completions` provider for a Claude
  model, i.e. the same defect in a different product, and it needs a separate
  change on that client's configuration.
- Long-run behaviour of the fix under `--concurrency 8` on large PRs. The
  measured arms used one file and concurrency 2; the cached share should rise
  with more calls per review, but that is an inference, not a measurement.

## 8. Outcome after the fix (2026-10-22, live)

Two repositories run this OCR workflow against the same `github-ocr` key, so the
0% path was never one workflow: `cloverinternational/trebol` and
`cloverinternational/plataforma` (a third, `plexus-fork`, carries a copy but no
live traffic was observed). Both were on `OCR_LLM_PROTOCOL=openai`. The same
change was merged in both (`trebol#345`, `trebol#347`, `plataforma#468`) and both
repositories had their two variables flipped.

Workflow dispatches on real pull requests, read back from `request_usage`:

| repo | incoming → provider | requests | uncached | cache read | cache write | cost |
|---|---|---|---|---|---|---|
| trebol, before | chat → claude-oauth | 105 | 2,181,709 | 0 | 0 | $5.44 |
| trebol, after | messages → claude-oauth | 154 | **358** | **4,017,111** | 1,271,913 | $1.46 |
| plataforma, after | messages → claude-oauth | 135 | **330** | **1,966,166** | 610,910 | $1.54 |

The two "after" rows are the same kind of review work that the "before" row
billed entirely at the uncached rate: ~5.3M prompt tokens for $1.46 instead of
$5.44 for 2.2M. Uncached input fell from 100% of the prompt to **0.007%**.

Operational note: Plexus caches the `api_keys` row in memory, so the allowlist
edit above only took effect after `docker restart plexus-green` (≈4 s of
downtime, verified healthy with `X-Plexus-Slot: green` immediately after). The
variable flip alone produced `403 Key is not allowed to access model
'claude-sonnet-5' for messages` until that restart.

`plexus-fork` was left alone; if it starts running reviews it needs the same
three changes, and its spend will show up on the same key.
