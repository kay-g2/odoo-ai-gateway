# Odoo 20 ↔ AI gateway protocol

The contract the gateway implements, read from the Odoo 20.0 client in `enterprise/ai`
(`utils/ai_utils.py`, `utils/types.py`, `models/ai_session.py`, `models/ai_embedding.py`,
`models/ai_agent.py`, `models/mail_call_artifact.py`, `controllers/ai.py`, `controllers/thread.py`,
`tests/common.py`), from `odoo/addons/iap/tools/iap_tools.py` and from `odoo/odoo/tools/misc.py`.

## Transport

`call_odoo_ai_transport()` posts JSON-RPC 2.0 to `{endpoint}/api/odoo_ai/{route}`:

```json
{"jsonrpc": "2.0", "method": "call", "params": {...}, "id": "<uuid hex>"}
```

- `endpoint` is the system parameter `ai.endpoint`, or `https://ai.api.odoo.com` when unset. Odoo
  builds the URL without normalizing it, so an endpoint ending in `/` yields `//api/odoo_ai/...`;
  the gateway collapses repeated slashes.
- When the route needs IAP credentials (`add_iap_token=True`), Odoo adds `account_token` (the
  `odoo_ai` IAP account token for the current companies) and `dbuuid`.
- `iap_jsonrpc` calls `raise_for_status()` and returns `response["result"]`. On `error` it reads
  `error.data.name`, and only a name ending in `InsufficientCreditError` gets special handling.
  The gateway answers JSON-RPC errors with HTTP 200 and a dotted `error.data.name`
  (`odoo_ai_gateway.errors.<Class>`).
- Odoo's timeouts: 5 s for `1/get_completions` (`IAP_TRANSPORT_TIMEOUT`), 60 s for the other
  `call_odoo_ai` calls including `1/get_completions_sync` (whatever `timeout` the params carry),
  5 s for `1/report_realtime_session_usage`.

## Routes

| Route | Token | Params | Result |
|---|---|---|---|
| `1/get_completions` | yes | completion params + `request_uuid`, `webhook_url`, `webhook_secret`, `webhook_dbname`, `llm_retry` | `{}` (ack), then webhook |
| `1/get_completions_sync` | yes | completion params | `{"status": "success", "result": <assistant message>}` |
| `1/get_embeddings` | yes | `input: [{title?, content}]`, `model`, `mode: "document"\|"query"` | `{"status": "success", "embeddings": [[1536 floats], ...]}` |
| `1/get_default_embedding_model` | **no** | `{}` | `"<model name>"` |
| `1/get_supported_embedding_models` | **no** | `{}` | `["<model name>", ...]` |
| `1/get_transcription` | yes | `audio` (base64), `mimetype`, `language?`, `response_format?: "vtt"` | `{"status": "success", "text": "..."}` |
| `1/get_realtime_session_token` | yes | `language`, `prompt` | `{"session_token": "...", "iap_transaction_token": "..."}` |
| `1/report_realtime_session_usage` | **no** | `iap_transaction_token`, `usage` | `{}` (ignored by Odoo) |

### Completion params

Built by `ai.session._submit_agent_request` (agent chat) and `ai.session._get_completions`
(`_get_direct_response` / `_run_agentic_loop`, one-shot callers):

| Key | Type | Notes |
|---|---|---|
| `messages` | list | History, oldest first. See "Messages". |
| `instructions` | str | System prompt, loaded skills included. |
| `tools` | list \| `{}` \| null | `[{name, instructions, schema}]`. `_run_agentic_loop` sends `{}` when there are no tools. |
| `schema` | dict | JSON schema for the final answer: the text part must be that JSON (`json.loads(get_text_from_parts(...))`). |
| `usage` | str | `agent:<module.xmlid>` / `agent:custom` (`ai.agent._get_usage_string`), `channel_name`, `ai_field`, `web_search`, `ai_action`, `website_builder_css_polish`, `website_builder_shapes`, `esg_metrics`. Missing for image generation. |
| `boost_reasoning` | bool | "Think longer" (`ai.session.enable_think_longer`). |
| `web_grounding` | bool | `ai_field` and the `web_search` tool. Never combined with tools. |
| `image_generation` | bool | `ai.tool._generate_image_attachments`. Comes with `aspect_ratio`. |
| `aspect_ratio` | str | One of `21:9 16:9 9:16 5:4 4:5 4:3 3:4 3:2 2:3 1:1`. |
| `timeout` | number | Seconds. Sent by the website/campaign builders and some one-shot callers. |
| `resolve_web_sources` | bool | Leftover from `**completion_options` (`_ai_tool_web_search`). Ignored. |

### Messages

```jsonc
{"role": "user", "content": [
  {"type": "text", "text": "..."},
  {"type": "inline_data", "mimetype": "image/png", "data": "<base64>", "metadata": {"image_path": "..."}},
  {"type": "tool_result", "tool_name": "x", "tool_call_id": "call_1", "result": [<text|inline_data>], "success": true}
]}
{"role": "assistant", "content": [<text|inline_data|tool_call>], "provider_metadata": {...}}
```

Assistant messages are what the gateway returned earlier. Odoo stores them as `ai.session.event`
metadata and sends them back unchanged, which is how `provider_metadata` and `part.provider_data`
carry provider state across turns (OpenAI reasoning items, Claude thinking blocks, Gemini thought
signatures, OpenRouter `reasoning_details`).

The gateway normalizes the history once, before routing (`src/core/odoo-history.ts`):

- `metadata` on `inline_data` is Odoo bookkeeping and never reaches a provider.
- `inline_data` with empty `data` is dropped: Odoo sends `data: ''` for an empty image field, and
  providers reject empty attachments.
- Mimetypes are lowercased, stripped of parameters (`application/json; charset=utf-8`) and
  de-aliased (`image/jpg`, `audio/mp3`, `audio/x-wav`).
- `ir.attachment._ai_read` re-encodes images larger than 1024 px as PNG but keeps the original
  mimetype, so image mimetypes are corrected from their magic bytes.
- Each attachment is classified once as image, PDF, text (`text/*`, JSON, XML and SVG, sent as
  decoded text), audio or other file. The router derives `image_input` / `pdf_input` /
  `audio_input` from that class.

### Assistant message returned by the gateway

```jsonc
{"role": "assistant",
 "content": [
   {"type": "text", "text": "...", "sources": {"<hex>": {"url": "...", "source_name": "example.com"}}},
   {"type": "tool_call", "name": "tool_name", "args": {...object...}, "call_id": "call_1"},
   {"type": "inline_data", "mimetype": "image/png", "data": "<base64>"}
 ],
 "provider_metadata": {"provider": "openai", "model": "gpt-5.6", "usage": {...}, "openai": {...replay...},
                       "conversation_id": "cv_..."}}
```

- `args` must be an object: Odoo calls `tool_call['args'].keys()`.
- With web grounding, `text` contains `[WEB_SOURCE:<hex>]` markers and the part has `sources`
  (`_ai_tool_web_search` pops them, `apply_web_citations` renders them).
- The agent loop runs in Odoo: when `content` has a `tool_call`, Odoo runs the Python tool and
  calls the gateway again with the assistant turn plus a user turn of `tool_result` parts.
- `conversation_id` is minted by the gateway. No completion param identifies the conversation:
  `request_uuid` and `webhook_secret` are new every round; `dbuuid`, `account_token` and
  `webhook_url` are shared by every conversation; `ai.session.id`, `channel_id`, `resume_token` and
  the browser's `ai_session_identifier` never leave Odoo. What Odoo does provide: `provider_metadata`
  is required on every assistant message (`types.py`), stored verbatim in the `ai.session.event`
  jsonb metadata (`ai.session._continue_agent_loop`), never read, and replayed whole on every round and
  turn (`_get_history`, no limit); one-shot loops keep the messages in memory. So the gateway mints
  the id on the first request and reads it back from the oldest assistant message that carries one.
  jsonb reorders keys but not values, and the id is short ASCII because it sits inside the signed
  webhook body.

## Webhook (async completions)

`1/get_completions` must answer within 5 s. The gateway replies `{}` and later POSTs plain JSON
(the route is `type='json2'`, not JSON-RPC) to `webhook_url` (`/ai/completion_result_ready`):

```json
{"request_uuid": "...", "llm_result": {"status": "success", "result": <assistant message>}, "llm_error": false, "signature": "<hex>"}
```

- On failure the body is `llm_result: false` with `llm_error: "<message>"`, and Odoo posts "Oops, it
  looks like our AI is unreachable".
- The header `X-Odoo-Database: <webhook_dbname>` selects the database on multi-database servers
  (`odoo/http/router.py`).
- The callback runs the tool batch synchronously (`_continue_agent_loop` → `_advance_tool_batch`,
  nested `1/get_completions_sync` calls included). It can take minutes and is not idempotent while it
  runs, so the gateway never retries a POST that may have reached Odoo.
- `signature` is `odoo.tools.misc.hmac(None, "odoo_ai-webhook", (request_uuid, llm_result, llm_error), secret=webhook_secret)`:

```python
hmac.new(webhook_secret.encode(), repr(("odoo_ai-webhook", (request_uuid, llm_result, llm_error))).encode(), sha256).hexdigest()
```

Odoo computes it on the values `json.loads` parsed from the body. Printability, and therefore
escaping, follows the Unicode database of Odoo's Python (3.12 = 15.0, 3.13 = 15.1, 3.14 = 16.0), so
the gateway uses a Python 3.12 table and, before signing, replaces characters assigned after Unicode
15.0 with U+FFFD, along with NUL and lone surrogates, which PostgreSQL `jsonb` rejects.
`src/core/pyrepr.ts` reproduces CPython's `repr()`: dict key order, `True`/`False`/`None`, `int` vs
`float` with Python's float formatting (`1e-05`, `1e+16`), quote selection and escapes including the
non-printable Unicode categories. `test/fixtures/signature-vectors.json` was generated with Odoo's
own function (`scripts/gen_signature_vectors.py`).

## Realtime transcription

`ai/static/src/core/realtime_client.js` opens the WebSocket from the browser, directly to OpenAI:
the URL is `wss://api.openai.com/v1/realtime` and the subprotocols are `realtime` and
`openai-insecure-api-key.<session_token>`.

It streams 24 kHz PCM16 `input_audio_buffer.append` events, reads
`conversation.item.input_audio_transcription.completed`, and never sends `session.update`.

- The gateway only mints `session_token`: an OpenAI Realtime client secret
  (`POST /v1/realtime/client_secrets`) whose transcription session config (format, model, language,
  prompt, VAD) is bound to the key. The audio never goes through Odoo or the gateway.
- `iap_transaction_token` is an HMAC-signed id. The browser posts the token counts it collected to
  `/ai/transcription/report_realtime_session_usage`; Odoo forwards them to
  `1/report_realtime_session_usage`, which verifies the signature and logs the usage.

## Out of scope

The website scraper (`ai.scraper_base_url`, `ai.web.scraper.batch`) is a separate service and is
not implemented. Credits and billing (`InsufficientCreditError`) are not emulated either.
