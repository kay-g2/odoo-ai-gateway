# odoo-ai-gateway

A self-hosted replacement for `https://ai.api.odoo.com`, the service behind the **AI** app of
Odoo 20 Enterprise. It serves the same JSON-RPC routes the Odoo client calls and sends each job to
the provider, model and reasoning effort you configure: **OpenAI**, **Grok** (xAI), **Claude**
(Anthropic), **Gemini** or **OpenRouter**. TypeScript on [Hono](https://hono.dev), plain `fetch`,
no provider SDKs.

This project is not affiliated with, endorsed by or supported by Odoo S.A. It reimplements a
network protocol and ships no Odoo code.

```
Odoo (ai.session: agent loop, tools run in Python)
   │  JSON-RPC 2.0  POST {ai.endpoint}/api/odoo_ai/1/<route>
   ▼
odoo-ai-gateway ── router (config only) ──► adapter ──► OpenAI | Grok | Claude | Gemini | OpenRouter
   │
   └─► POST webhook_url  (signed result of async completions)
```

The agent stays in Odoo. Odoo sends `instructions`, `messages` and `tools: [{name, instructions,
schema}]`; the gateway returns what the model said (text, `tool_call` parts, generated images).
When there is a tool call, Odoo runs the Python tool and calls the gateway again with a
`tool_result` turn. The gateway never executes tools and never forwards anything to
`ai.api.odoo.com`.

## Quick start

```bash
npm install
cp gateway.config.example.yaml gateway.config.yaml   # routing; keys stay in env vars
cp .env.example .env                                 # the keys you use
npm run dev                                          # or: npm run build && npm start
```

Both scripts load `.env` with Node's `--env-file-if-exists`; variables already set in the
environment win. The gateway listens on :8080.

### Docker + OpenRouter

[`examples/openrouter`](examples/openrouter) runs the published image with OpenRouter as the only
provider, routed by its `config.yaml`:

```bash
cd examples/openrouter
cp .env.example .env          # set OPENROUTER_API_KEY and ODOO_AI_ACCOUNT_TOKEN
docker compose up -d
curl localhost:8080/health    # {"status":"ok"}
```

`GATEWAY_PORT=18080 docker compose up -d` publishes it on another port. The image is
`ghcr.io/kay-g2/odoo-ai-gateway` (tags `X.Y.Z`, `X.Y` and `latest`, linux/amd64 and linux/arm64).
To build it yourself: `docker build -t odoo-ai-gateway .`, then mount your config at
`/app/gateway.config.yaml` or set `ODOO_AI_GATEWAY_CONFIG`.

### Point Odoo at the gateway

1. **Endpoint.** In *Settings → Technical → System Parameters*, set `ai.endpoint` to the gateway
   base URL, e.g. `https://ai-gateway.example.com`. Odoo appends `/api/odoo_ai/<route>` itself. A
   trailing `/` and a reverse-proxy path prefix both work.
2. **Token.** Take the token of the `odoo_ai` account in
   *Settings → Technical → IAP → In-App Purchase Accounts* (Odoo creates it on first use; you can
   also set it yourself) and put it in `auth.accountTokens`. Odoo sends it as `account_token` on
   every protected route.
3. **Webhook.** The gateway must reach Odoo's public URL (`web.base.url`): async completions come
   back through `/ai/completion_result_ready`.

## Routes

| Route | Implemented as |
|---|---|
| `1/get_completions` | Acks `{}` at once (Odoo waits 5 s at most), runs the job in the background, then POSTs the signed plain-JSON body `{request_uuid, llm_result, llm_error, signature}` to `webhook_url` with `X-Odoo-Database: <webhook_dbname>`. |
| `1/get_completions_sync` | Same job, answered in the same POST: `{status: "success", result: {role, content, provider_metadata}}`. The provider deadline is capped at 60 s (`server.syncTimeoutSeconds`): Odoo's HTTP client stops waiting then, whatever `timeout` it sends. |
| `1/get_embeddings` | `{status, embeddings}`: one 1536-dimension vector per `input` item (`ai.embedding.embedding_vector` is `vector(1536)`). |
| `1/get_default_embedding_model`, `1/get_supported_embedding_models` | A string, a list. No `account_token`. |
| `1/get_transcription` | `{status, text}`: plain text for voice notes, WebVTT for call recordings (`response_format: "vtt"`). |
| `1/get_realtime_session_token` | `{session_token, iap_transaction_token}`. |
| `1/report_realtime_session_usage` | Verifies the signed `iap_transaction_token` and logs the usage. No `account_token`. |

Assistant message parts: `text` (with web grounding it carries `[WEB_SOURCE:<hex>]` markers and a
`sources` map `{<hex>: {url, source_name}}` that Odoo turns into citations), `tool_call {name, args,
call_id}` and `inline_data {mimetype, data}`. With `schema`, the answer is one text part holding
JSON that follows it; code fences are stripped and invalid JSON is an error.

The full contract, with the Odoo source it was read from, is in [docs/protocol.md](docs/protocol.md).

### Webhook signature

Odoo verifies the postback with `odoo.tools.misc.hmac`:

```
HMAC-SHA256(webhook_secret, repr(("odoo_ai-webhook", (request_uuid, llm_result, llm_error))))
```

`repr` is Python's `repr()` of what `json.loads` produced from the body. `src/core/pyrepr.ts`
reproduces it byte for byte: dict order, `True`/`False`/`None`, `int` vs `float` formatting
(`1e-05`), quoting and escaping. Which characters `repr` escapes depends on the Unicode database of
Odoo's Python (3.12: 15.0, 3.13: 15.1, 3.14: 16.0). Printability therefore comes from a table
generated from Python 3.12 (`src/core/python-unicode.ts`), and before signing the gateway replaces
with U+FFFD the characters assigned after Unicode 15.0, plus NUL and lone surrogates, which
PostgreSQL `jsonb` rejects. The signature then matches on every Python that Odoo 20 supports. The
sync route is not signed and only replaces NUL and lone surrogates.
`test/fixtures/signature-vectors.json` holds vectors produced by Odoo's own `hmac`.

### Webhook delivery

Odoo runs the whole tool batch inside the webhook request (tool code, nested LLM calls, website
builder passes), so a callback can take minutes and is not idempotent while it runs.

- The POST waits up to `webhook.timeoutSeconds` (300 s by default).
- It is retried only when it certainly did not reach Odoo: connection refused, DNS failure, connect
  timeout, or a 429/503 answer. Timeouts, other 5xx and proxy 502/504 are not retried, so tools
  never run twice.
- Redirects are not followed. Set Odoo's `web.base.url` to its final public URL.

### Realtime transcription (the editor's Voice Transcript)

The WebSocket does not pass through the gateway. Odoo's browser code opens
`wss://api.openai.com/v1/realtime` directly, with the ephemeral key as the
`openai-insecure-api-key.<token>` subprotocol. `1/get_realtime_session_token` mints that key with
`POST /v1/realtime/client_secrets`, binding the transcription session (24 kHz PCM16, model,
language, prompt, server VAD) to it, because the browser never sends `session.update`. This route
needs the **OpenAI** provider. The gateway returns an HMAC-signed `iap_transaction_token` with the
key; Odoo later posts the token counts the browser collected to `1/report_realtime_session_usage`,
which checks the signature and logs them.

## Routing

Only configuration decides. The job comes from the route, `params.usage` and the request flags.
Odoo 20 sends these `usage` values:

| `usage` | Sent by |
|---|---|
| `agent:<module.xmlid>` / `agent:custom` | agent chats (`ai.agent._get_usage_string`) |
| `channel_name` | chat titles |
| `ai_field` | AI fields (schema + web grounding) |
| `web_search` | web search tool (web grounding) |
| `ai_action` | server actions |
| `website_builder_css_polish` / `website_builder_shapes` | website builder passes, lowest reasoning |
| `esg_metrics` | ESG metrics (schema) |
| *(none)* | image generation |

The most specific entry wins:

1. `routing.usages[<usage>]`
2. `routing.agent`, for any `agent:*` usage without its own entry
3. `routing.features.image_generation`, then `routing.features.web_grounding`, for requests with
   those flags
4. `routing.routes[<route>]`, e.g. `1/get_embeddings`, `1/get_transcription`,
   `1/get_realtime_session_token`
5. `routing.default`

An entry is inline, `{provider, model, effort?, maxOutputTokens?, options?, capabilities?}`, or the
name of a **tier**. `tiers` is ordered from lightest to heaviest. `boost_reasoning` (Odoo's "Think
longer") moves the job one row up: a tier entry goes to the next tier; an inline entry, or the top
tier, gets one more effort level on `none < minimal < low < medium < high < xhigh < max` (unset
counts as `medium`).

**Feature checks, no fallback.** The request's needs (`tools`, `schema`, `web_grounding`,
`image_generation`, image/PDF/audio attachments, and the pairs `web_grounding+schema` and
`tools+schema`) are checked against the chosen provider and model. A missing one fails the request
with `UnsupportedFeatureError`, which names the job, provider, model and feature; the gateway never
switches to another provider. `capabilities: {feature: true|false}` on an entry forces a
capability, which is useful for new OpenRouter models.

**Embeddings.** The `1/get_embeddings` entry is the default model; its `name` (or `model`) is what
Odoo stores and sends back. `embeddings.additional` keeps older models accepted. Every model must
produce 1536 dimensions. To switch models: change the entry, restart Odoo (it caches the model
lists with `ormcache`), then run the scheduled action *AI Embedding: Update deprecated embedding
models*, which moves agents and re-embeds their sources. `gemini-embedding-2` takes the task as a
text prefix (`title: <title | none> | text: <content>` for documents, `task: search result | query:
<content>` for queries), the format Odoo's own service used: vectors stored by Odoo re-embed
through the gateway with cosine similarity 1.0000. Odoo 20 only injects RAG chunks scoring at least
0.9 (`ai.embedding._get_similar_chunks`), which natural questions rarely reach with any service.

See [`gateway.config.example.yaml`](gateway.config.example.yaml).

## Providers

All adapters implement `src/providers/types.ts` (`supports`, `complete`, `embed`, `transcribe`,
`createRealtimeSession`). They translate the canonical effort to each API and clamp it to what the
model accepts.

| Feature | OpenAI | Grok (xAI) | Claude | Gemini | OpenRouter |
|---|---|---|---|---|---|
| API used | Responses | Responses (+ Images, STT) | Messages | generateContent | Chat Completions |
| Tools (`tool_call` / `tool_result`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Schema (structured output) | ✓ | ✓ | ✓ (not on Claude 3 / Opus 4.0 / Sonnet 4.0) | ✓ | ✓ (`require_parameters`) |
| `web_grounding` (`[WEB_SOURCE:]` + `sources`) | `web_search` tool | `web_search` tool | `web_search` server tool | `googleSearch` | `openrouter:web_search` |
| `web_grounding` + schema (`ai_field`) | ✓ | ✓ | ✗ (citations are incompatible with structured output) | Gemini 3+ | ✓ |
| `image_generation` | `image_generation` tool | `/images/generations` (image models) | ✗ | `*-image` models | `modalities: [image, text]` |
| Image / PDF / audio input | ✓ / ✓ / ✗ | jpeg-png / ✗ / ✗ | ✓ / ✓ / ✗ | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ |
| Embeddings (1536) | ✓ `dimensions` | ✗ | ✗ | embedding models (normalized) | ✓ |
| Transcription (`vtt`) | ✓ (native VTT on `whisper-1`) | ✓ `/stt` (VTT from word timings) | ✗ | ✓ | ✓ (VTT from segments) |
| Realtime session token | ✓ `client_secrets` | ✗ | ✗ | ✗ | ✗ |
| Replayed state across turns | reasoning items (`encrypted_content`) | reasoning items | thinking blocks + signatures (`drop_block` binding) | `thoughtSignature` + call ids | `reasoning_details` |

**Effort.** An unset effort sends no reasoning parameter at all.

| Provider | Translation |
|---|---|
| OpenAI | `reasoning.effort`, clamped per model family: gpt-6 has no `minimal`, gpt-5.4 caps at `xhigh`, the original gpt-5 is `minimal`..`high`, o-series is `low`..`high`. Non-reasoning models (gpt-4.x) get no reasoning field. |
| Grok | `reasoning.effort`, clamped per model: 4.6/4.7 `low`..`xhigh`, 4.5 `low`..`high`, 4.3 `none`..`high`, grok-3-mini `low`/`high`. Models that reject the parameter get none. |
| Claude | Adaptive models (4.6+, 5.x): `thinking: {type: "adaptive"}` plus `output_config.effort` (`low`..`max`; `xhigh` only where supported; `none` becomes `low` without thinking). Budget models (Haiku 4.5, 4.5, 4.1, 4.0, 3.7): `thinking.budget_tokens` from 1024 to 32000. |
| Gemini | Gemini 3+: `thinkingLevel` (`minimal`/`low`/`medium`/`high`; Pro starts at `low`). Gemini 2.5: `thinkingBudget` (0 to 32768). Image models get no thinking config. |
| OpenRouter | `reasoning.effort`, passed through. `max` becomes `xhigh`, except for Anthropic models; `none` is `{enabled: false}` for Anthropic models. |

**Prompt caching.** OpenAI and Gemini cache repeated prompt prefixes automatically. Claude (direct,
or `anthropic/*` through OpenRouter) only caches at explicit `cache_control` breakpoints, placed the
way Odoo builds its history: one on the system prompt (tools + system together) and, in agent
chats, one on the last block before the current user message, because Odoo rewrites that message
every round with a fresh `<odoo_current_context>`. One-shot loops only append, so automatic caching
follows the tail. Measured with Claude Opus 5.5 through OpenRouter: from the third round of a chat
on, about 95 % of the prompt is read from the cache. `options.prompt_cache: false` on an entry
disables it, `"1h"` uses the one-hour TTL.

**Conversation id.** Odoo sends no conversation id, but it stores every assistant message verbatim,
`provider_metadata` included, and replays the whole history on every round and turn. So the gateway
mints one (`cv_` + 22 base64url characters) on a conversation's first request, returns it in
`provider_metadata.conversation_id`, and reads it back from the oldest assistant message afterwards.
It is logged as `conversation` with every completion and used to route caches:

| Provider | Field | Default | Why |
|---|---|---|---|
| OpenRouter | `session_id` | on | Pins every round to the same upstream provider. Without it, OpenRouter keys stickiness on a hash of the first messages, which changes every round of an Odoo chat's first turn. |
| Grok | `prompt_cache_key` (Responses API) | on | xAI caches per server and routes by this key. |
| OpenAI | `prompt_cache_key` | **off** | Different keys never share cached prefixes, so a per-conversation key would stop one agent's chats from sharing the cached instructions + tools. GPT-5.6+ routes the cache automatically. |
| Claude, Gemini | none | | Claude's cache is keyed by content at the breakpoints; Gemini's implicit cache has no routing key. |

Override it per entry: `options.prompt_cache_key` on OpenAI and Grok (`"conversation"`, any other
string sent as is, or `false`), `options.session_id` on OpenRouter (a string or `false`). Subagent
sessions, chat titles and completions nested inside a tool each get their own id, because Odoo
sends them without the parent's history. A first response that fails is never stored, so the next
request starts a new id.

**Per-entry `options`.** Extra fields for the provider request. At startup every entry's options
are checked against what its provider's adapter declares: a wrong value, or one of the
gateway's own keys (`prompt_cache`, `image_generation_tool`, `x_search_tool`,
`embedding_prompt`, `expires_after_seconds`) on a provider that does not read it, stops the
gateway with the entry's path. A key that is another provider's API field (`session_id`,
`prompt_cache_key`, `reasoning`, `generationConfig`...) is not rejected: it is sent upstream
like any other key. The keys below are read by the adapter, or merged
recursively into the object it builds, for the operations listed. Any other key is copied into the
upstream request as is (an extra form field for multipart transcriptions), replacing what the
adapter built; `null` removes the field, e.g. `dimensions: null` for fixed-size embedding models.
Grok image generation is the exception: the `/images/generations` body only takes what is inside
`image_generation_tool`; other keys are ignored there.

<!-- options-table:begin (generated by `npm run docs:options`) -->
| Provider | Key | Operations | Value | Effect |
|---|---|---|---|---|
| openai | `web_search_tool` | completion | an object | Merged into the `web_search` tool (`search_context_size`...). |
| openai | `image_generation_tool` | completion | an object | Merged into the `image_generation` tool (`quality`...). |
| openai | `prompt_cache_key` | completion | a string or false | `"conversation"` sends the conversation id (see Conversation id), another string is sent as is, `false` sends none. Default: none. |
| openai | `expires_after_seconds` | realtime | a positive integer | Lifetime of the client secret. Default: 600. |
| openai | `turn_detection` | realtime | an object or null | Replaces the default server VAD; `null` turns it off. |
| openai | `noise_reduction` | realtime | an object or null | Replaces the default `near_field`; `null` turns it off. |
| openai | `transcription` | realtime | an object | Merged into the session's transcription config (`prompt`...). |
| grok | `web_search_tool` | completion | an object | Merged into the `web_search` tool (`allowed_domains`...). |
| grok | `x_search_tool` | completion | true or false or an object | `true` or an object (merged into it) adds an `x_search` tool to web-grounded requests. |
| grok | `image_generation_tool` | completion | an object | Merged into the `/images/generations` body (`resolution`, `quality`...). |
| grok | `prompt_cache_key` | completion | a string or false | `"conversation"` sends the conversation id (see Conversation id), another string is sent as is, `false` sends none. Default: the conversation id. |
| claude | `web_search_tool` | completion | an object | Merged into the `web_search` server tool (`max_uses`, `allowed_domains`...). |
| claude | `prompt_cache` | completion | true or false or "5m" or "1h" | Cache breakpoints (see Prompt caching): `false` turns them off, `"1h"` uses the one-hour TTL. Default: on, 5 minutes. |
| gemini | `generationConfig` | completion, transcription | an object | Merged recursively into the adapter's `generationConfig`: `temperature`, `topP`...; the thinking and schema settings are kept. |
| gemini | `toolConfig` | completion | an object | Merged recursively into the adapter's `toolConfig`: function calling settings (`functionCallingConfig`...). |
| gemini | `web_search_tool` | completion | an object | Merged into the `googleSearch` tool. |
| gemini | `embedContentConfig` | embeddings | an object | Merged recursively into the adapter's `embedContentConfig`: each embedding request's config (`taskType`...). |
| gemini | `embedding_prompt` | embeddings | true or false | Forces the task-prefix text format on or off (default: on for gemini-embedding-2, see Embeddings). |
| openrouter | `web_search_tool` | completion | an object | `parameters` of the `openrouter:web_search` tool (`engine`, `max_results`...). |
| openrouter | `provider` | completion | an object | Merged recursively into the adapter's `provider`: provider routing preferences (`order`, `only`, `sort`...); a schema adds `require_parameters: true` first. |
| openrouter | `image_config` | completion | an object | Extra image options (`image_size`...) for image generation; the request's aspect ratio wins. |
| openrouter | `reasoning` | completion | an object | Merged over the translated effort (`exclude`...); a `max_tokens` budget replaces the effort. |
| openrouter | `prompt_cache` | completion | true or false or "5m" or "1h" | Cache breakpoints (see Prompt caching): `false` turns them off, `"1h"` uses the one-hour TTL. Default: on, 5 minutes. |
| openrouter | `session_id` | completion | a string or false | Sticky-routing key (see Conversation id). Default: the conversation id; `false` sends none. |
<!-- options-table:end -->

**Known limits:**

- Grok image generation sends only the text prompt, so it cannot edit an input image.
- Claude cannot serve `ai_field`, which sends a schema together with web grounding. Route it to
  OpenAI, Grok, Gemini 3 or OpenRouter.
- Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 bind thinking blocks to the conversation prefix, which
  Odoo rewrites every round. The adapter sends `block_binding: {prefix_mismatch_behavior:
  "drop_block"}`, so earlier thinking is dropped instead of failing the request.

## Operations

**Shutdown.** On SIGTERM the gateway stops accepting connections and waits for in-flight requests
and pending async completions, webhook deliveries included, for at most
`completionTimeoutSeconds + webhook.timeoutSeconds × maxAttempts` (25 min with the defaults). Give
the container that much stop time (`docker --stop-timeout`, Kubernetes
`terminationGracePeriodSeconds`).

**Security.**

- Keep `auth.accountTokens` set. `allowAnyAccountToken: true` lets anyone who can reach the gateway
  spend your provider credits.
- `webhook.allowedHosts` restricts where results may be posted. Without it, any authenticated
  caller chooses the URL. Redirects are never followed.
- Routes without `account_token` (the embedding-model listings and the usage report) accept bodies
  of 64 KB at most.
- Realtime usage reports need a signed `iap_transaction_token`: accepted once, expiring after 12 h,
  numeric fields only. Set `auth.transactionTokenSecret` so tokens survive restarts. Replay
  protection is per process: after a restart, or on another instance sharing the secret, a token
  can be reported once more within its TTL.
- Logs carry job, provider, model, timings and token usage, never secrets or keys. Prompts and
  outputs are not logged either, with one exception: a failed provider call logs the provider's
  error message as is, which can quote request or model text.

**Out of scope.** The website scraper (`ai.scraper_base_url`) and IAP credit accounting
(`InsufficientCreditError` is never raised).

## Development

```bash
npm test               # vitest, fully offline: fetch throws, *_API_KEY variables are removed
npm run typecheck
npm run docs:options   # regenerates the options table above (a test checks it is current)
```

Adapters are tested against hand-written provider responses served by a mocked `fetch`
(`test/helpers/mock-fetch.ts`), routes end to end with scripted adapters.
Regenerating the signature fixtures needs Python 3.12 with Odoo importable, and the newest
supported Python in `PY_NEWEST`:

```bash
ODOO_PATH=./odoo PY_NEWEST=python3.14 python3.12 scripts/gen_signature_vectors.py > test/fixtures/signature-vectors.json
PY_NEWEST=python3.14 python3.12 scripts/gen_python_unicode.py > src/core/python-unicode.ts
```

Commits and releases: [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities: [SECURITY.md](SECURITY.md).

## License

MIT. Not affiliated with Odoo S.A.
