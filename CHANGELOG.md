# Changelog

## 0.1.0 (2026-09-30)

### Features

* the JSON-RPC routes of Odoo 20's AI service: completions (async with signed webhook, and sync), embeddings, transcription, realtime session tokens and usage reports
* adapters for OpenAI, Grok, Claude, Gemini and OpenRouter; routing by usage, tier and effort from the config file only
* prompt caching and conversation ids for cache routing across turns
* Docker image and an OpenRouter-only compose example
